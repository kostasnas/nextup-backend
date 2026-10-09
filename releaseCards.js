// releaseCards.js
// Data + routes for the "release cards" marketing tool: upcoming K-dramas,
// doramas, anime and Turkish series, with where-to-watch and a ready-to-post
// caption (Brazilian Portuguese by default, English on request: ?lang=en). A small web page (tools/release-cards.html)
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
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PER_CATEGORY = 20;
const TWEET_LIMIT = 270; // X allows 280; leave headroom (emoji count double)

// Everything that depends on the audience's language lives here: TMDB language and
// region (where-to-watch), dates, card text and caption wording. Portuguese (Brazil)
// is the default and behaves exactly as before; English targets the global K-drama crowd.
const LANGS = {
  pt: {
    code: "pt", tmdbLang: "pt-BR", region: "BR", tz: "America/Sao_Paulo", intl: "pt-BR",
    titleLangs: [["pt", "BR"], ["pt", null], ["en", null]],
    googleWhere: "onde assistir", gl: "br", hl: "pt-BR",
    kinds: {
      premiere: { tag: "ESTREIA", label: "Estreia" },
      season: { tag: "NOVA TEMPORADA", label: "Nova temporada" },
      episode: { tag: "NOVO EPISÓDIO", label: "Novo episódio" },
    },
    ui: {
      whereLabel: "Onde assistir", whereTbc: "a confirmar", episodeLabel: "Episódio", episodesLabel: "Episódios",
      seasonLabel: "Temporada", seasonOf: "temporada", noPoster: "sem pôster",
      footer: "Acompanhe suas séries · link na bio", credit: "Dados: TMDB",
    },
    when: { today: "hoje", tomorrow: "amanhã" },
    dayMonth: (m, d) => `${d}/${m}`,
    head: {
      season: ({ title, season, when }) => `A temporada ${season} de ${title} estreia ${when}.`,
      episode: ({ title, season, episode, when }) => `Novo episódio de ${title} ${when}: temporada ${season}, episódio ${episode}.`,
      premiere: ({ title, when }) => `${title} estreia ${when}.`,
    },
    whereCaption: " Onde assistir: ",
    tail: "Vai ver? Conta pra gente 👇 Link na bio.",
    warnPlatform: "Η πλατφόρμα δεν είναι ακόμα επιβεβαιωμένη στο TMDB — έλεγξε πριν ποστάρεις.",
    warnOverview: "Δεν υπάρχει περίληψη στα πορτογαλικά.",
    labels: { kdrama: "K-drama", cdrama: "C-drama", dorama: "Dorama", anime: "Anime", turca: "Novela turca", variedades: "Variedades" },
    tags: { kdrama: ["dorama", "kdrama"], cdrama: ["dorama", "cdrama"], dorama: ["dorama"], anime: ["anime"], turca: ["novelaturca", "diziturca"], variedades: ["variedades", "coreia"] },
  },
  en: {
    code: "en", tmdbLang: "en-US", region: "US", tz: "America/New_York", intl: "en-US",
    titleLangs: [["en", "US"], ["en", null]],
    googleWhere: "where to watch", gl: "us", hl: "en",
    kinds: {
      premiere: { tag: "PREMIERE", label: "Premiere" },
      season: { tag: "NEW SEASON", label: "New season" },
      episode: { tag: "NEW EPISODE", label: "New episode" },
    },
    ui: {
      whereLabel: "Where to watch", whereTbc: "to be confirmed", episodeLabel: "Episode", episodesLabel: "Episodes",
      seasonLabel: "Season", seasonOf: "season", noPoster: "no poster",
      footer: "Track your shows · link in bio", credit: "Data: TMDB",
    },
    when: { today: "today", tomorrow: "tomorrow" },
    dayMonth: (m, d) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d}`,
    head: {
      season: ({ title, season, when }) => `Season ${season} of ${title} premieres ${when}.`,
      episode: ({ title, season, episode, when }) => `New episode of ${title} ${when}: season ${season}, episode ${episode}.`,
      premiere: ({ title, when }) => `${title} premieres ${when}.`,
    },
    whereCaption: " Where to watch: ",
    tail: "Will you watch? Tell us 👇 Link in bio.",
    warnPlatform: "Η πλατφόρμα δεν είναι ακόμα επιβεβαιωμένη στο TMDB — έλεγξε πριν ποστάρεις.",
    warnOverview: "Δεν υπάρχει αγγλική περίληψη.",
    labels: { kdrama: "K-drama", cdrama: "C-drama", dorama: "Asian drama", anime: "Anime", turca: "Turkish drama", variedades: "K-variety" },
    tags: { kdrama: ["kdrama"], cdrama: ["cdrama"], dorama: ["asiandrama"], anime: ["anime"], turca: ["turkishdrama", "dizi"], variedades: ["kvariety", "korea"] },
  },
};
const DEFAULT_LANG = "pt";
const getLang = (code) => LANGS[code] || LANGS[DEFAULT_LANG];

// TMDB genre ids: 16 Animation, 10764 Reality, 10767 Talk. Variety shows (e.g. Running Man) are
// not dramas, so they get their own list instead of topping the drama lists with #kdrama on them.
const NOT_DRAMA = [16, 10764, 10767];
const CATEGORIES = [
  { key: "kdrama", params: "with_origin_country=KR&without_genres=16|10764|10767", exclude: NOT_DRAMA},
  { key: "cdrama", params: "with_origin_country=CN&without_genres=16|10764|10767", exclude: NOT_DRAMA},
  { key: "dorama", params: "with_origin_country=JP|TH|TW&without_genres=16|10764|10767", exclude: NOT_DRAMA},
  { key: "anime", params: "with_origin_country=JP&with_genres=16"},
  { key: "turca", params: "with_origin_country=TR"},
  { key: "variedades", params: "with_origin_country=KR&with_genres=10764|10767&without_genres=16"},
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

// ---- dates (always in the audience's own time zone) ----------------------

function todayIn(tz, now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function todayInBrazil(now = new Date()) { return todayIn(LANGS.pt.tz, now); }

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T12:00:00Z`) - new Date(`${fromIso}T12:00:00Z`)) / 86400000);
}

function weekday(isoDate, L) {
  return new Intl.DateTimeFormat(L.intl, { weekday: "long", timeZone: "UTC" }).format(new Date(`${isoDate}T12:00:00Z`));
}

function dayMonth(isoDate, L) {
  const [, m, d] = isoDate.split("-").map(Number);
  return L.dayMonth(m, d);
}

function longDate(isoDate, L) {
  return new Intl.DateTimeFormat(L.intl, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(`${isoDate}T12:00:00Z`));
}

// pt: "hoje", "amanhã (9/10)", "sábado (10/10)" · en: "today", "tomorrow (Oct 9)", "Saturday (Oct 10)"
function whenText(isoDate, today, L) {
  const diff = daysBetween(today, isoDate);
  if (diff === 0) return L.when.today;
  if (diff === 1) return `${L.when.tomorrow} (${dayMonth(isoDate, L)})`;
  return `${weekday(isoDate, L)} (${dayMonth(isoDate, L)})`;
}
const whenPt = (isoDate, today) => whenText(isoDate, today, LANGS.pt);

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

function captionHead({ title, when, kind = "premiere", season, episode, L = LANGS.pt }) {
  return L.head[kind]({ title, when, season, episode });
}

function buildCaption({ title, when, platforms, overview, tags, kind = "premiere", season, episode, L = LANGS.pt }) {
  const where = platforms.length ? `${L.whereCaption}${platforms.join(", ")}.` : "";
  const head = `${captionHead({ title, when, kind, season, episode, L })}${where}`;
  const tail = `\n\n${L.tail}\n${tags.map((t) => `#${t}`).join(" ")}`;

  let synopsis = firstSentence(overview);
  // TMDB overviews often start with the title itself ("X is a remake…"): the caption
  // already opens with it, so drop the repeat and keep the rest.
  if (synopsis.toLowerCase().startsWith(String(title).toLowerCase())) {
    synopsis = synopsis.slice(String(title).length).replace(/^[\s,:;–-]+/, "");
    synopsis = synopsis.charAt(0).toUpperCase() + synopsis.slice(1);
  }
  const build = (syn) => `${head}${syn ? ` ${syn}` : ""}${tail}`;
  let caption = build(synopsis);
  while (synopsis && tweetLength(caption) > TWEET_LIMIT) {
    // Never end on a half sentence: cut back to the last comma and close it, or drop the synopsis.
    const room = Math.min(synopsis.length - 10, 200);
    const cut = synopsis.slice(0, room);
    const comma = cut.lastIndexOf(", ");
    synopsis = comma > 30 ? `${cut.slice(0, comma)}.` : "";
    caption = build(synopsis);
  }
  return caption;
}

// ---- data -----------------------------------------------------------------

function pickPlatforms(detail, L) {
  // Subscription first, then free/ad-supported (e.g. Viki) — both answer "where to watch".
  const r = detail["watch/providers"]?.results?.[L.region] || {};
  const flat = [...(r.flatrate || []), ...(r.free || []), ...(r.ads || [])];
  const sorted = [...flat].sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));
  const names = [];
  for (const p of sorted) {
    if (p.provider_name && !names.includes(p.provider_name)) names.push(p.provider_name);
  }
  return names.slice(0, 2);
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]+$/u;

// TMDB returns the original-language name when there is no title in the audience's
// language (most Chinese/Turkish series), which is useless for them. Prefer the title in
// their language (pt: pt-BR, pt-PT, English · en: en-US, English), then whatever TMDB gave us.
function pickTitle(detail, L = LANGS.pt) {
  const tr = detail.translations?.translations || [];
  const nameOf = (pred) => tr.find((t) => pred(t) && t.data?.name)?.data.name;
  for (const [lang, country] of L.titleLangs) {
    const n = nameOf((t) => t.iso_639_1 === lang && (!country || t.iso_3166_1 === country));
    if (n) return n;
  }
  return detail.name || detail.original_name;
}

function toItem(detail, category, today, ev, L = LANGS.pt) {
  const date = ev.date;
  const platforms = pickPlatforms(detail, L);
  const when = whenText(date, today, L);
  const title = pickTitle(detail, L);
  const tags = [...L.tags[category.key]];
  const titleTag = slugTag(title);
  // A hashtag cut in the middle of a word looks broken, so very long titles get none.
  if (titleTag && titleTag.length <= 24) tags.push(titleTag);
  const platformTag = slugTag(platforms[0]);
  if (platformTag) tags.push(platformTag);

  const warnings = [];
  if (!platforms.length) warnings.push(L.warnPlatform);
  if (!detail.overview) warnings.push(L.warnOverview);

  const args = { title, when, kind: ev.kind, season: ev.season, episode: ev.episode, L };
  return {
    id: detail.id,
    title,
    kind: ev.kind,
    kindTag: L.kinds[ev.kind].tag,
    kindLabel: L.kinds[ev.kind].label,
    season: ev.season ?? null,
    episode: ev.episode ?? null,
    category: category.key,
    categoryLabel: L.labels[category.key],
    date,
    daysFromToday: daysBetween(today, date),
    when,
    dateLong: longDate(date, L),
    platforms,
    // For a title that has only just been listed TMDB often knows only the first
    // episode or two, so a very small count is not the real total — leave it off the card.
    episodes: ev.kind === "premiere" && detail.number_of_episodes > 2 ? detail.number_of_episodes : null,
    // TMDB's own numbers. Very new titles have few or no votes, so the rating is only
    // shown once there are enough votes to mean something; popularity is always present.
    genreIds: (detail.genres || []).map((g) => g.id),
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

async function loadCategory(category, today, until, L) {
  const base = `language=${L.tmdbLang}&sort_by=popularity.desc&${category.params}`;
  const yesterday = addDays(today, -1);
  const [premieres, onAir] = await Promise.all([
    // first episode in the window = a premiere
    tmdbGet(`/discover/tv?${base}&include_null_first_air_dates=false&first_air_date.gte=${today}&first_air_date.lte=${until}`),
    // some episode in the window, but the show started earlier = new season or new episode
    tmdbGet(`/discover/tv?${base}&air_date.gte=${today}&air_date.lte=${until}&first_air_date.lte=${yesterday}`),
  ]);

  const fetchDetail = (id) => tmdbGet(`/tv/${id}?language=${L.tmdbLang}&append_to_response=watch/providers,translations`);
  const usable = (item) =>
    item &&
    LATIN_ONLY.test(item.title) && // e.g. 美人余 — nothing the audience can read
    !(category.exclude || []).some((g) => item.genreIds.includes(g));
  const safe = (label, fn) => async (r) => {
    try { return await fn(r); } catch (e) { console.error(`release-cards: skipped ${category.key} ${label} ${r.id}:`, e.message); return null; }
  };

  const premiereItems = await mapPool((premieres.results || []).slice(0, PER_CATEGORY), 8, safe("premiere", async (r) => {
    const d = await fetchDetail(r.id);
    if (!d.first_air_date) return null;
    return toItem(d, category, today, { kind: "premiere", date: d.first_air_date }, L);
  }));

  const seen = new Set(premiereItems.filter(Boolean).map((i) => i.id));
  const ongoingPicks = (onAir.results || []).filter((r) => !seen.has(r.id)).slice(0, PER_CATEGORY);
  const ongoingItems = await mapPool(ongoingPicks, 8, safe("on-air", async (r) => {
    const d = await fetchDetail(r.id);
    const ne = d.next_episode_to_air;
    // Only a real upcoming episode inside the window (not specials, which are season 0).
    if (!ne || !ne.air_date || ne.season_number < 1 || ne.air_date < today || ne.air_date > until) return null;
    const kind = ne.episode_number === 1 && ne.season_number > 1 ? "season" : "episode";
    return toItem(d, category, today, { kind, date: ne.air_date, season: ne.season_number, episode: ne.episode_number }, L);
  }));

  return [...premiereItems, ...ongoingItems].filter(usable);
}

async function buildReleaseCards(days, L) {
  const today = todayIn(L.tz);
  const until = addDays(today, days);
  const settled = await Promise.all(
    CATEGORIES.map((c) => loadCategory(c, today, until, L).catch((e) => {
      console.error(`release-cards: category ${c.key} failed:`, e.message);
      return [];
    }))
  );
  // Titles with a confirmed platform first (they are the ones you can post without checking),
  // then by date.
  const items = settled.flat().sort((a, b) =>
    (b.platforms.length > 0) - (a.platforms.length > 0) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return {
    generatedAt: new Date().toISOString(), today, days, lang: L.code, region: L.region, items,
    // Text the page needs for the card image and the Google link (so the client has no language of its own).
    ui: { ...L.ui, whereCaption: L.whereCaption, googleWhere: L.googleWhere, gl: L.gl, hl: L.hl },
  };
}

async function getReleaseCards(days, langCode = DEFAULT_LANG) {
  const L = getLang(langCode);
  const key = `${L.code}:${days}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  if (inflight.has(key)) return inflight.get(key);

  const p = buildReleaseCards(days, L)
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
      const data = await getReleaseCards(days, req.query.lang === "en" ? "en" : "pt");
      res.setHeader("Cache-Control", "no-store");
      res.json(data);
    } catch (e) {
      console.error("release-cards failed:", e.message);
      res.status(503).json({ error: "Could not load releases right now. Try again in a minute." });
    }
  }));
}

module.exports = { mountReleaseCards, getReleaseCards, buildCaption, whenPt, whenText, todayInBrazil, slugTag, pickTitle, LATIN_ONLY, LANGS };
