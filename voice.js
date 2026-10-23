// voice.js
// EXPERIMENT: control the app by voice. The phone turns speech into text; this turns the text into a
// plan (mark episodes watched, post an episode comment, or "just recommend something") that the app shows
// for confirmation before anything is written.
//
// LOCKED to the developer account while it is being tried out: every route answers 403 for anyone else and
// /voice/status tells the app whether to show the microphone. Nothing here is stored.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.VOICE_MODEL || "openai/gpt-oss-120b";
const MAX_EPISODES_PER_SHOW = 30;

const adminId = () => process.env.ADMIN_USER_ID || "47d65eeb-e49b-4854-a5e4-64b468541886";

// "The Bear" / "the-bear!" / "Η ΑΡΚΟΥΔΑ" -> comparable key
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// The model is told to answer with a title from the list, but speech is messy: accept an exact match first,
// then a title that contains / is contained in what was said. Several equally good matches = ambiguous.
function matchShow(said, shows) {
  const key = norm(said);
  if (!key) return { show: null, ambiguous: [] };
  const exact = shows.filter((s) => norm(s.title) === key);
  if (exact.length === 1) return { show: exact[0], ambiguous: [] };
  if (exact.length > 1) return { show: null, ambiguous: exact };
  const loose = shows.filter((s) => {
    const t = norm(s.title);
    return t && (t.includes(key) || key.includes(t));
  });
  if (loose.length === 1) return { show: loose[0], ambiguous: [] };
  return { show: null, ambiguous: loose };
}

function buildPrompt({ shows, context, languageHint }) {
  const list = shows.slice(0, 250).map((s) => s.title).join(" | ");
  const ctx = context && context.showTitle
    ? `The person currently has open: "${context.showTitle}"${context.season != null ? ` season ${context.season}` : ""}${context.episode != null ? ` episode ${context.episode}` : ""}. "this episode" / "this show" means that.`
    : "Nothing is open in the app right now, so \"this episode\" cannot be resolved.";
  return `You turn a spoken request to a TV tracking app into JSON. The request may be in any language (often Greek or English)${languageHint ? `; the app language is ${languageHint}` : ""}.
The person's tracked shows (use these exact titles in "show"): ${list || "none"}
${ctx}

Reply ONLY with one JSON object:
{"intent": "mark_watched" | "comment" | "recommend" | "other",
 "marks": [{"show": "<exact title from the list>", "season": <number or null>, "episode": <number or null>, "count": <number or null>}],
 "comment": {"show": "<exact title>", "season": <number or null>, "episode": <number or null>, "text": "<the comment, in the language the person dictated it>"} or null,
 "reply": "<one short sentence in the person's language, only for intent other>"}

Rules:
- mark_watched: "I watched episode 3 of season 2 of X" -> season 2, episode 3. "I watched 3 episodes of X today" / "I watched the next 3 of X" -> count 3, season and episode null (the next unwatched ones). "I watched X" with no numbers -> count 1. "Mark this episode" -> use the open show/season/episode. One mark per show; several shows in one request = several marks.
- comment: the person wants to post a comment on an episode. Put only the comment text itself in "text", without the instruction words.
- recommend: asks what to watch / for suggestions.
- other: anything else, or a title that is not in the list (then explain briefly in "reply").
- Never invent a show that is not in the list.`;
}

async function askModel(system, text) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: text }],
      temperature: 0,
      max_tokens: 1500, // this model spends part of the budget on a reasoning trace first
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

function mountVoice(app, { supabase, requireAuth, asyncHandler }) {
  const onlyDeveloper = (req, res) => {
    if (req.userId === adminId()) return true;
    res.status(403).json({ error: "Not available" });
    return false;
  };

  app.get("/voice/status", requireAuth, (req, res) => {
    res.json({ enabled: req.userId === adminId() });
  });

  async function loadShows(userId) {
    const { data, error } = await supabase
      .from("user_watchlist")
      .select("status, shows(id, tmdb_id, title)")
      .eq("user_id", userId)
      .limit(500);
    if (error) throw error;
    return (data || []).map((r) => r.shows).filter((s) => s && s.title);
  }

  // Episodes of one show in watching order, with whether this person has watched each one.
  async function loadEpisodes(userId, showId) {
    const { data: eps, error } = await supabase
      .from("episodes")
      .select("id, season_number, episode_number, air_date")
      .eq("show_id", showId)
      .gt("season_number", 0)
      .order("season_number")
      .order("episode_number")
      .limit(5000);
    if (error) throw error;
    const ids = (eps || []).map((e) => e.id);
    const watched = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: w, error: wErr } = await supabase
        .from("watched_episodes").select("episode_id").eq("user_id", userId).in("episode_id", ids.slice(i, i + 200));
      if (wErr) throw wErr;
      (w || []).forEach((r) => watched.add(r.episode_id));
    }
    return (eps || []).map((e) => ({ ...e, watched: watched.has(e.id) }));
  }

  async function planMark(userId, mark, shows, today) {
    const { show, ambiguous } = matchShow(mark.show, shows);
    if (!show) {
      return { problem: ambiguous.length > 1
        ? `"${mark.show}" matches several of your shows: ${ambiguous.slice(0, 4).map((s) => s.title).join(", ")}`
        : `I couldn't find "${mark.show}" in your shows` };
    }
    const eps = await loadEpisodes(userId, show.id);
    const season = Number.isInteger(mark.season) ? mark.season : null;
    const episode = Number.isInteger(mark.episode) ? mark.episode : null;

    if (season != null && episode != null) {
      const hit = eps.find((e) => e.season_number === season && e.episode_number === episode);
      if (!hit) return { problem: `${show.title} has no S${season}E${episode}` };
      return { show, episodes: [hit], alreadyWatched: hit.watched ? [hit] : [] };
    }

    const count = Math.max(1, Math.min(MAX_EPISODES_PER_SHOW, Number.isInteger(mark.count) ? mark.count : 1));
    // "the next N": first unwatched episodes that have already aired, in order
    const next = eps.filter((e) => !e.watched && e.air_date && e.air_date <= today).slice(0, count);
    if (!next.length) return { problem: `Nothing left to mark for ${show.title}` };
    return { show, episodes: next, alreadyWatched: [] };
  }

  app.post("/voice/interpret", requireAuth, asyncHandler(async (req, res) => {
    if (!onlyDeveloper(req, res)) return;
    const text = String(req.body?.text || "").trim().slice(0, 600);
    if (!text) return res.status(400).json({ error: "text is required" });
    const context = req.body?.context || null;
    const today = new Date().toISOString().slice(0, 10);

    const shows = await loadShows(req.userId);
    let parsed;
    try {
      parsed = await askModel(buildPrompt({ shows, context, languageHint: req.body?.locale }), text);
    } catch (e) {
      console.error("voice interpret failed:", e.message);
      return res.status(502).json({ error: "Couldn't understand that, try again" });
    }

    const intent = parsed.intent;
    if (intent === "recommend") return res.json({ type: "recommend", transcript: text });
    if (intent !== "mark_watched" && intent !== "comment") {
      return res.json({ type: "unknown", transcript: text, reply: parsed.reply || null });
    }

    const problems = [];
    const marks = [];
    if (intent === "mark_watched") {
      for (const m of (Array.isArray(parsed.marks) ? parsed.marks : []).slice(0, 8)) {
        const r = await planMark(req.userId, m, shows, today);
        if (r.problem) { problems.push(r.problem); continue; }
        marks.push({
          showTitle: r.show.title,
          tmdbId: r.show.tmdb_id,
          episodes: r.episodes.map((e) => ({ id: e.id, season: e.season_number, episode: e.episode_number })),
          alreadyWatched: r.alreadyWatched.length,
        });
      }
    }

    let comment = null;
    if (intent === "comment" && parsed.comment?.text) {
      const c = parsed.comment;
      const { show, ambiguous } = matchShow(c.show, shows);
      if (!show) problems.push(ambiguous.length > 1 ? `"${c.show}" matches several of your shows` : `I couldn't find "${c.show}" in your shows`);
      else if (!Number.isInteger(c.season) || !Number.isInteger(c.episode)) problems.push("Say which season and episode the comment is for");
      else {
        const eps = await loadEpisodes(req.userId, show.id);
        const hit = eps.find((e) => e.season_number === c.season && e.episode_number === c.episode);
        if (!hit) problems.push(`${show.title} has no S${c.season}E${c.episode}`);
        else comment = { episodeId: hit.id, label: `${show.title} S${c.season}E${c.episode}`, text: String(c.text).slice(0, 1000) };
      }
    }

    res.json({ type: "plan", transcript: text, marks, comment, problems });
  }));

  // Writes the confirmed plan's watched episodes. Only ids that exist are accepted; the same row the
  // app's own tick writes (source "manual").
  app.post("/voice/apply-watched", requireAuth, asyncHandler(async (req, res) => {
    if (!onlyDeveloper(req, res)) return;
    const ids = [...new Set((Array.isArray(req.body?.episodeIds) ? req.body.episodeIds : []).filter((x) => x != null))].slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: "episodeIds is required" });
    const { data: found, error } = await supabase.from("episodes").select("id").in("id", ids);
    if (error) throw error;
    const rows = (found || []).map((e) => ({ user_id: req.userId, episode_id: e.id, source: "manual" }));
    if (rows.length) {
      const { error: upErr } = await supabase.from("watched_episodes").upsert(rows, { onConflict: "user_id,episode_id", ignoreDuplicates: true });
      if (upErr) throw upErr;
    }
    res.json({ ok: true, marked: rows.length });
  }));
}

module.exports = { mountVoice, matchShow, norm };
