// voice.js
// EXPERIMENT: control the app by voice. The phone turns speech into text; this turns the text into a
// plan (mark episodes watched, post an episode comment, or "just recommend something") that the app shows
// for confirmation before anything is written.
//
// LOCKED to the developer account while it is being tried out: every route answers 403 for anyone else and
// /voice/status tells the app whether to show the microphone. Nothing here is stored.
const { searchShow, searchMovie } = require("./tmdbMatcher");
const { setMovieStatus } = require("./movies");

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
    // whole-word containment, so "you" does not match "young sheldon"
    return t && ((` ${t} `).includes(` ${key} `) || (` ${key} `).includes(` ${t} `));
  });
  if (loose.length === 1) return { show: loose[0], ambiguous: [] };
  if (loose.length > 1) return { show: null, ambiguous: loose };
  // Speech recognition mishears names ("slow horses" -> "slow horse", "hannah" -> "hanna"): accept a title
  // within a small edit distance, but only when it is clearly the closest one.
  const scored = shows
    .map((s) => ({ s, d: editDistance(norm(s.title), key) }))
    .filter((x) => x.d <= Math.max(1, Math.floor(key.length / 5)))
    .sort((a, b) => a.d - b.d);
  if (scored.length && (scored.length === 1 || scored[1].d > scored[0].d)) return { show: scored[0].s, ambiguous: [] };
  return { show: null, ambiguous: scored.map((x) => x.s) };
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function buildPrompt({ shows, movies, context, languageHint }) {
  const list = shows.slice(0, 250).map((s) => s.title).join(" | ");
  const movieList = movies.slice(0, 150).map((m) => m.title).join(" | ");
  const ctx = context && context.showTitle
    ? `The person currently has open: "${context.showTitle}"${context.season != null ? ` season ${context.season}` : ""}${context.episode != null ? ` episode ${context.episode}` : ""}. "this show" means that show; if no season/episode is open, "the next episode" means count 1 of it.`
    : "Nothing is open in the app right now, so \"this episode\" cannot be resolved.";
  return `You turn a spoken request to a TV and movie tracking app into JSON. The request may be in any language (often Greek or English)${languageHint ? `; the app language is ${languageHint}` : ""}.
The person's tracked shows: ${list || "none"}
The person's tracked movies: ${movieList || "none"}
${ctx}

Reply ONLY with one JSON object:
{"intent": "mark_watched" | "open" | "comment" | "recommend" | "other",
 "marks": [{"kind": "show" | "movie", "title": "<title>", "season": <number or null>, "episode": <number or null>, "count": <number or null>}],
 "open": {"title": "<title>", "kind": "show" | "movie" | null} or null,
 "comment": {"show": "<exact title>", "season": <number or null>, "episode": <number or null>, "text": "<the comment, in the language the person dictated it>"} or null,
 "reply": "<one short sentence in the person's language, only for intent other>"}

Rules:
- mark_watched, shows: "I watched episode 3 of season 2 of X" -> season 2, episode 3. "I watched 3 episodes of X today" / "the next 3 of X" -> count 3, season and episode null (the next unwatched ones). "I watched X" with no numbers -> count 1. "Mark this episode" -> use the open show/season/episode. One mark per show; several shows in one request = several marks.
- mark_watched, movies: "I watched the movie X" / "mark movie X as watched" -> kind "movie" (season/episode/count null). If the person says "movie"/"film" use kind "movie"; if it is clearly a tracked show use "show".
- open: "open X", "go to X", "show me X" -> {"title": X, "kind": ...}. Titles that are not tracked are fine here (they are searched).
- comment: the person wants to post a comment on an episode. Put only the comment text itself in "text", without the instruction words.
- recommend: asks what to watch / for suggestions.
- other: anything else (then explain briefly in "reply").
- The request comes from speech recognition, so titles are often misheard, split or transliterated (English titles written in Greek letters, e.g. "Μπρέικινγκ Μπαντ" = "Breaking Bad"). For tracked titles put the one from the lists that SOUNDS closest; otherwise give the title as you best understand it, in its original / English form as listed on TMDB (not transliterated into another alphabet).`;
}

async function askModel(system, text) {
  const call = (extra) => fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: text }],
      temperature: 0,
      max_tokens: 2000, // this model spends part of the budget on a reasoning trace first
      response_format: { type: "json_object" },
      ...extra,
    }),
  });
  // A short reasoning trace is plenty for this (and faster); fall back if the parameter is rejected.
  let res = await call({ reasoning_effort: "low" });
  if (res.status === 400) res = await call({});
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
    // Shows being watched right now come first: they are what people talk about, and the prompt lists only
    // the first 250 titles.
    const rank = (st) => (st === "watching" ? 0 : st === "planned" ? 1 : 2);
    return (data || [])
      .filter((r) => r.shows && r.shows.title)
      .sort((a, b) => rank(a.status) - rank(b.status))
      .map((r) => r.shows);
  }

  async function loadMovies(userId) {
    const { data, error } = await supabase
      .from("user_movie_watchlist")
      .select("status, movies(id, tmdb_id, title, poster_path, release_date, runtime, overview)")
      .eq("user_id", userId)
      .limit(500);
    if (error) throw error;
    return (data || []).filter((r) => r.movies && r.movies.title).map((r) => ({ ...r.movies, status: r.status }));
  }

  const yearOf = (d) => (d ? String(d).slice(0, 4) : null);

  // A movie to mark watched: one of the person's tracked movies, otherwise the best TMDB match.
  async function planMovie(mark, movies) {
    const said = mark.title || mark.show;
    const { show: hit } = matchShow(said, movies);
    if (hit) {
      return { movie: { tmdb_id: hit.tmdb_id, title: hit.title, poster_path: hit.poster_path, release_date: hit.release_date, runtime: hit.runtime, overview: hit.overview }, alreadyWatched: hit.status === "watched" };
    }
    const results = await searchMovie(said);
    const r = results && results[0];
    if (!r) return { problem: `I couldn't find a movie called "${said}"` };
    return { movie: { tmdb_id: r.id, title: r.title, poster_path: r.poster_path || null, release_date: r.release_date || null, runtime: null, overview: r.overview || null }, alreadyWatched: false };
  }

  // "open X": tracked show/movie first, otherwise the most popular TMDB match.
  async function resolveOpen(open, shows, movies) {
    const said = open?.title;
    if (!said) return null;
    const kind = open.kind === "show" || open.kind === "movie" ? open.kind : null;
    if (kind !== "movie") { const { show } = matchShow(said, shows); if (show) return { kind: "show", tmdbId: show.tmdb_id, title: show.title }; }
    if (kind !== "show") { const { show } = matchShow(said, movies); if (show) return { kind: "movie", tmdbId: show.tmdb_id, title: show.title }; }
    const [tv, mv] = await Promise.all([
      kind !== "movie" ? searchShow(said).catch(() => []) : [],
      kind !== "show" ? searchMovie(said).catch(() => []) : [],
    ]);
    const t = tv && tv[0], m = mv && mv[0];
    if (t && (!m || (t.popularity || 0) >= (m.popularity || 0))) return { kind: "show", tmdbId: t.id, title: t.name };
    if (m) return { kind: "movie", tmdbId: m.id, title: m.title };
    return null;
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
    const today = new Date().toISOString().slice(0, 10);

    const [shows, movies] = await Promise.all([loadShows(req.userId), loadMovies(req.userId)]);
    // The app can say which show is open (by TMDB id) so "I watched the next episode" needs no title.
    let context = null;
    const openId = Number(req.body?.context?.showTmdbId);
    const openShow = Number.isInteger(openId) ? shows.find((s) => s.tmdb_id === openId) : null;
    if (openShow) context = { showTitle: openShow.title };
    let parsed;
    try {
      parsed = await askModel(buildPrompt({ shows, movies, context, languageHint: req.body?.locale }), text);
    } catch (e) {
      console.error("voice interpret failed:", e.message);
      return res.status(502).json({ error: "Couldn't understand that, try again" });
    }

    const intent = parsed.intent;
    if (intent === "recommend") return res.json({ type: "recommend", transcript: text });
    if (intent === "open") {
      let target = null;
      try { target = await resolveOpen(parsed.open, shows, movies); } catch (e) { console.error("voice open failed:", e.message); }
      if (!target) return res.json({ type: "unknown", transcript: text, reply: `I couldn't find "${parsed.open?.title || text}"` });
      return res.json({ type: "open", transcript: text, ...target });
    }
    if (intent !== "mark_watched" && intent !== "comment") {
      return res.json({ type: "unknown", transcript: text, reply: parsed.reply || null });
    }

    const problems = [];
    const marks = [];
    if (intent === "mark_watched") {
      for (const m of (Array.isArray(parsed.marks) ? parsed.marks : []).slice(0, 8)) {
        if (m.kind === "movie") {
          let r;
          try { r = await planMovie(m, movies); } catch (e) { r = { problem: "Couldn't look that movie up, try again" }; }
          if (r.problem) { problems.push(r.problem); continue; }
          const yr = yearOf(r.movie.release_date);
          marks.push({ kind: "movie", showTitle: yr ? `${r.movie.title} (${yr})` : r.movie.title, tmdbId: r.movie.tmdb_id, movie: r.movie, episodes: [], alreadyWatched: r.alreadyWatched ? 1 : 0 });
          continue;
        }
        const r = await planMark(req.userId, { ...m, show: m.title || m.show }, shows, today);
        if (r.problem) { problems.push(r.problem); continue; }
        marks.push({
          kind: "show",
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
  // app's own tick writes (source "manual"), plus the same list-status moves the app makes when ticking:
  // the show's last episode -> Completed (ended) / Up to date, otherwise Planned/Favourite -> Watching.
  app.post("/voice/apply-watched", requireAuth, asyncHandler(async (req, res) => {
    if (!onlyDeveloper(req, res)) return;
    const ids = [...new Set((Array.isArray(req.body?.episodeIds) ? req.body.episodeIds : []).filter((x) => x != null))].slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: "episodeIds is required" });
    const { data: found, error } = await supabase.from("episodes").select("id, show_id, season_number, episode_number").in("id", ids);
    if (error) throw error;
    const rows = (found || []).map((e) => ({ user_id: req.userId, episode_id: e.id, source: "manual" }));
    if (rows.length) {
      const { error: upErr } = await supabase.from("watched_episodes").upsert(rows, { onConflict: "user_id,episode_id", ignoreDuplicates: true });
      if (upErr) throw upErr;
    }

    // list status per affected show (best effort: the episodes are already saved)
    try {
      const byShow = new Map();
      for (const e of found || []) { if (!byShow.has(e.show_id)) byShow.set(e.show_id, []); byShow.get(e.show_id).push(e); }
      for (const [showId, marked] of byShow) {
        const [{ data: showRow }, { data: wl }, { data: last }] = await Promise.all([
          supabase.from("shows").select("status").eq("id", showId).maybeSingle(),
          supabase.from("user_watchlist").select("status").eq("user_id", req.userId).eq("show_id", showId).maybeSingle(),
          supabase.from("episodes").select("id").eq("show_id", showId).gt("season_number", 0)
            .order("season_number", { ascending: false }).order("episode_number", { ascending: false }).limit(1),
        ]);
        if (!wl) continue; // not on the list: nothing to move
        const finaleId = last && last[0] && last[0].id;
        let status = wl.status;
        if (finaleId && marked.some((m) => m.id === finaleId)) {
          const ended = showRow && (showRow.status === "Ended" || showRow.status === "Canceled");
          status = ended ? "completed" : "up_to_date";
        } else if (wl.status === "planned" || wl.status === "favorite") {
          status = "watching";
        }
        await supabase.from("user_watchlist").update({ status, updated_at: new Date().toISOString() }).eq("user_id", req.userId).eq("show_id", showId);
      }
    } catch (e) {
      console.error("voice: status update failed:", e.message);
    }
    res.json({ ok: true, marked: rows.length });
  }));

  // Marks one movie watched (the same write the app's own "Watched" button makes).
  app.post("/voice/apply-movie", requireAuth, asyncHandler(async (req, res) => {
    if (!onlyDeveloper(req, res)) return;
    const m = req.body?.movie || {};
    if (!Number.isInteger(m.tmdb_id) || m.tmdb_id <= 0 || typeof m.title !== "string" || !m.title) return res.status(400).json({ error: "movie is required" });
    await setMovieStatus(supabase, req.userId, {
      tmdb_id: m.tmdb_id, title: m.title.slice(0, 300), poster_path: m.poster_path || null,
      release_date: m.release_date || null, runtime: m.runtime || null, overview: m.overview || null,
    }, "watched");
    res.json({ ok: true });
  }));
}

module.exports = { mountVoice, matchShow, norm };
