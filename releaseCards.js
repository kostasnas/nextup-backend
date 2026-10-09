// releaseCards.js
// Data + routes for the "release cards" marketing tool: upcoming K-dramas,
// doramas, anime and Turkish series, with where-to-watch and a ready-to-post
// caption (Brazilian Portuguese). A small web page (tools/release-cards.html)
// turns each item into a 1080x1350 image in the browser.
//
// Everything here is public TMDB data (no user data), so the routes need no
// auth — but they are cached (6h), concurrency-collapsed and bounded, the
// same way the other public /discover routes are, so they can't be used to
// fan out unbounded TMDB calls.

const fs = require("fs");
const path = require("path");
const { throttle } = require("./tmdbThrottle");

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = process.env.TMDB_IMAGE_BASE || "https://image.tmdb.org/t/p";
const TZ = "America/Sao_Paulo";
const REGION = "BR";
const LANG = "pt-BR";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PER_CATEGORY = 20;
const TWEET_LIMIT = 270; // X allows 280; leave headroom (emoji count double)

const CATEGORIES = [
  { key: "kdrama", label: "K-drama", params: "with_origin_country=KR&without_genres=16", tags: ["dorama", "kdrama"] },
  { key: "cdrama", label: "C-drama", params: "with_origin_country=CN&without_genres=16", tags: ["dorama", "cdrama"] },
  { key: "dorama", label: "Dorama", params: "with_origin_country=JP|TH|TW&without_genres=16", tags: ["dorama"] },
  { key: "anime", label: "Anime", params: "with_origin_country=JP&with_genres=16", tags: ["anime"] },
  { key: "turca", label: "Novela turca", params: "with_origin_country=TR", tags: ["novelaturca", "diziturca"] },
];

const cache = new Map(); // key -> { data, expiresAt }
const inflight = new Map(); // key -> Promise (collapses concurrent identical requests)

async function tmdbGet(p) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not configured");
  const url = `${TMDB_BASE}${p}${p.includes("?") ? "&" : "?"}api_key=${apiKey}`;
  return throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB request failed (${res.status})`);
    return res.json();
  });
}

// ---- dates (always Brasília time, since the audience is Brazilian) -------

function todayInBrazil(now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T12:00:00Z`) - new Date(`${fromIso}T12:00:00Z`)) / 86400000);
}

function weekdayPt(isoDate) {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: "UTC" }).format(new Date(`${isoDate}T12:00:00Z`));
}

function dayMonth(isoDate) {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${d}/${m}`;
}

function longDatePt(isoDate) {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(`${isoDate}T12:00:00Z`));
}

// "hoje", "amanhã (9/10)", "sábado (10/10)"
function whenPt(isoDate, today) {
  const diff = daysBetween(today, isoDate);
  if (diff === 0) return "hoje";
  if (diff === 1) return `amanhã (${dayMonth(isoDate)})`;
  return `${weekdayPt(isoDate)} (${dayMonth(isoDate)})`;
}

// ---- caption --------------------------------------------------------------

function slugTag(text) {
  return String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstSentence(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : t).trim();
}

function tweetLength(s) {
  // X counts most emoji as 2; approximate by counting astral code points twice.
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  return n;
}

const KINDS = {
  premiere: { tag: "ESTREIA", label: "Estreia" },
  season: { tag: "NOVA TEMPORADA", label: "Nova temporada" },
  episode: { tag: "NOVO EPISÓDIO", label: "Novo episódio" },
};

function captionHead({ title, when, kind = "premiere", season, episode }) {
  if (kind === "season") return `A temporada ${season} de ${title} estreia ${when}.`;
  if (kind === "episode") return `Novo episódio de ${title} ${when}: temporada ${season}, episódio ${episode}.`;
  return `${title} estreia ${when}.`;
}

function buildCaption({ title, when, platforms, overview, tags, kind = "premiere", season, episode }) {
  const where = platforms.length ? ` Onde assistir: ${platforms.join(", ")}.` : "";
  const head = `${captionHead({ title, when, kind, season, episode })}${where}`;
  const tail = `\n\nVai ver? Conta pra gente 👇 Link na bio.\n${tags.map((t) => `#${t}`).join(" ")}`;

  let synopsis = firstSentence(overview);
  // TMDB overviews often start with the title itself ("X é um remake…"): the caption
  // already opens with it, so drop the repeat and keep the rest.
  if (synopsis.toLowerCase().startsWith(String(title).toLowerCase())) {
    synopsis = synopsis.slice(String(title).length).replace(/^[\s,:;–-]+/, "");
    synopsis = synopsis.charAt(0).toUpperCase() + synopsis.slice(1);
  }
  const build = (syn) => `${head}${syn ? ` ${syn}` : ""}${tail}`;
  let caption = build(synopsis);
  while (synopsis && tweetLength(caption) > TWEET_LIMIT) {
    const room = synopsis.length - 10;
    // cut back to a whole word, then drop dangling punctuation
    synopsis = room > 30 ? `${synopsis.slice(0, room).replace(/\s+\S*$/, "").replace(/[\s,;:.]+$/, "")}…` : "";
    caption = build(synopsis);
  }
  return caption;
}

// ---- data -----------------------------------------------------------------

function pickPlatforms(detail) {
  // Subscription first, then free/ad-supported (e.g. Viki) — both answer "onde assistir".
  const r = detail["watch/providers"]?.results?.[REGION] || {};
  const flat = [...(r.flatrate || []), ...(r.free || []), ...(r.ads || [])];
  const sorted = [...flat].sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));
  const names = [];
  for (const p of sorted) {
    if (p.provider_name && !names.includes(p.provider_name)) names.push(p.provider_name);
  }
  return names.slice(0, 2);
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]+$/u;

// TMDB returns the original-language name when there is no Portuguese title (most
// Chinese/Turkish series), which is useless for a Brazilian audience. Prefer the pt-BR
// title, then pt-PT, then English, then whatever TMDB gave us.
function pickTitle(detail) {
  const tr = detail.translations?.translations || [];
  const nameOf = (pred) => tr.find((t) => pred(t) && t.data?.name)?.data.name;
  return (
    nameOf((t) => t.iso_639_1 === "pt" && t.iso_3166_1 === "BR") ||
    nameOf((t) => t.iso_639_1 === "pt") ||
    nameOf((t) => t.iso_639_1 === "en") ||
    detail.name ||
    detail.original_name
  );
}

function toItem(detail, category, today, ev) {
  const date = ev.date;
  const platforms = pickPlatforms(detail);
  const when = whenPt(date, today);
  const title = pickTitle(detail);
  const tags = [...category.tags];
  const titleTag = slugTag(title);
  // A hashtag cut in the middle of a word looks broken, so very long titles get none.
  if (titleTag && titleTag.length <= 24) tags.push(titleTag);
  const platformTag = slugTag(platforms[0]);
  if (platformTag) tags.push(platformTag);

  const warnings = [];
  if (!platforms.length) warnings.push("Plataforma ainda não confirmada no TMDB — verifique antes de postar.");
  if (!detail.overview) warnings.push("Sem sinopse em português.");

  const args = { title, when, kind: ev.kind, season: ev.season, episode: ev.episode };
  return {
    id: detail.id,
    title,
    kind: ev.kind,
    kindTag: KINDS[ev.kind].tag,
    kindLabel: KINDS[ev.kind].label,
    season: ev.season ?? null,
    episode: ev.episode ?? null,
    category: category.key,
    categoryLabel: category.label,
    date,
    daysFromToday: daysBetween(today, date),
    when,
    dateLong: longDatePt(date),
    platforms,
    // For a title that has only just been listed TMDB often knows only the first
    // episode or two, so a very small count is not the real total — leave it off the card.
    episodes: ev.kind === "premiere" && detail.number_of_episodes > 2 ? detail.number_of_episodes : null,
    // TMDB's own numbers. Very new titles have few or no votes, so the rating is only
    // shown once there are enough votes to mean something; popularity is always present.
    popularity: Math.round((detail.popularity || 0) * 10) / 10,
    rating: detail.vote_count >= 5 ? Math.round(detail.vote_average * 10) / 10 : null,
    votes: detail.vote_count || 0,
    posterUrl: detail.poster_path ? `${IMG_BASE}/w780${detail.poster_path}` : null,
    captionHead: captionHead(args),
    caption: buildCaption({ ...args, platforms, overview: detail.overview, tags }),
    warnings,
  };
}

// Runs fn over arr in small parallel batches (the shared TMDB throttle still applies).
async function mapPool(arr, size, fn) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(...(await Promise.all(arr.slice(i, i + size).map(fn))));
  return out;
}

async function loadCategory(category, today, until) {
  const base = `language=${LANG}&sort_by=popularity.desc&${category.params}`;
  const yesterday = addDays(today, -1);
  const [premieres, onAir] = await Promise.all([
    // first episode in the window = a premiere
    tmdbGet(`/discover/tv?${base}&include_null_first_air_dates=false&first_air_date.gte=${today}&first_air_date.lte=${until}`),
    // some episode in the window, but the show started earlier = new season or new episode
    tmdbGet(`/discover/tv?${base}&air_date.gte=${today}&air_date.lte=${until}&first_air_date.lte=${yesterday}`),
  ]);

  const fetchDetail = (id) => tmdbGet(`/tv/${id}?language=${LANG}&append_to_response=watch/providers,translations`);
  const usable = (item) => item && LATIN_ONLY.test(item.title); // e.g. 美人余 — nothing a Brazilian reader can use
  const safe = (label, fn) => async (r) => {
    try { return await fn(r); } catch (e) { console.error(`release-cards: skipped ${category.key} ${label} ${r.id}:`, e.message); return null; }
  };

  const premiereItems = await mapPool((premieres.results || []).slice(0, PER_CATEGORY), 8, safe("premiere", async (r) => {
    const d = await fetchDetail(r.id);
    if (!d.first_air_date) return null;
    return toItem(d, category, today, { kind: "premiere", date: d.first_air_date });
  }));

  const seen = new Set(premiereItems.filter(Boolean).map((i) => i.id));
  const ongoingPicks = (onAir.results || []).filter((r) => !seen.has(r.id)).slice(0, PER_CATEGORY);
  const ongoingItems = await mapPool(ongoingPicks, 8, safe("on-air", async (r) => {
    const d = await fetchDetail(r.id);
    const ne = d.next_episode_to_air;
    // Only a real upcoming episode inside the window (not specials, which are season 0).
    if (!ne || !ne.air_date || ne.season_number < 1 || ne.air_date < today || ne.air_date > until) return null;
    const kind = ne.episode_number === 1 && ne.season_number > 1 ? "season" : "episode";
    return toItem(d, category, today, { kind, date: ne.air_date, season: ne.season_number, episode: ne.episode_number });
  }));

  return [...premiereItems, ...ongoingItems].filter(usable);
}

async function buildReleaseCards(days) {
  const today = todayInBrazil();
  const until = addDays(today, days);
  const settled = await Promise.all(
    CATEGORIES.map((c) => loadCategory(c, today, until).catch((e) => {
      console.error(`release-cards: category ${c.key} failed:`, e.message);
      return [];
    }))
  );
  // Titles with a confirmed platform first (they are the ones you can post without checking),
  // then by date.
  const items = settled.flat().sort((a, b) =>
    (b.platforms.length > 0) - (a.platforms.length > 0) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { generatedAt: new Date().toISOString(), today, days, region: REGION, items };
}

async function getReleaseCards(days) {
  const key = String(days);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  if (inflight.has(key)) return inflight.get(key);

  const p = buildReleaseCards(days)
    .then((data) => {
      // Don't cache an all-empty result: it usually means TMDB hiccuped.
      if (data.items.length) cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---- routes ----------------------------------------------------------------

// Read lazily (and memoized) so a missing file can never stop the server from booting.
const fileCache = {};
const read = (f) => (fileCache[f] ??= fs.readFileSync(path.join(__dirname, "tools", f), "utf8"));

function mountReleaseCards(app, asyncHandler) {
  const imgOrigin = new URL(IMG_BASE).origin;

  app.get("/tools/release-cards", (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ` +
      `img-src 'self' data: blob: ${imgOrigin}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`
    );
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(read("release-cards.html"));
  });

  app.get("/tools/release-cards.js", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript").send(read("release-cards.js"));
  });

  app.get("/tools/release-cards.json", asyncHandler(async (req, res) => {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 10));
    try {
      const data = await getReleaseCards(days);
      res.setHeader("Cache-Control", "no-store");
      res.json(data);
    } catch (e) {
      console.error("release-cards failed:", e.message);
      res.status(503).json({ error: "Could not load releases right now. Try again in a minute." });
    }
  }));
}

module.exports = { mountReleaseCards, getReleaseCards, buildCaption, whenPt, todayInBrazil, slugTag, pickTitle, LATIN_ONLY };
