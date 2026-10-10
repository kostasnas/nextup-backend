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
      streaming: { tag: "JÁ DISPONÍVEL", label: "Estreou em" },
      movie: { tag: "NOS CINEMAS", label: "Estreia nos cinemas" },
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
      streaming: ({ title }) => `${title} já está disponível.`,
      movie: ({ title, when }) => `${title} estreia nos cinemas ${when}.`,
    },
    theaters: "Nos cinemas",
    whereCaption: " Onde assistir: ",
    tail: "Vai ver? Conta pra gente 👇 Link na bio.",
    tailTrending: "Você está assistindo? Conta pra gente 👇 Link na bio.",
    warnPlatform: "Η πλατφόρμα δεν είναι ακόμα επιβεβαιωμένη στο TMDB — έλεγξε πριν ποστάρεις.",
    warnOverview: "Δεν υπάρχει περίληψη στα πορτογαλικά.",
    labels: { kdrama: "K-drama", cdrama: "C-drama", dorama: "Dorama", anime: "Anime", turca: "Novela turca", variedades: "Variedades", trending: "Em alta", movies: "Filmes", other: "Série" },
    tags: { kdrama: ["dorama", "kdrama"], cdrama: ["dorama", "cdrama"], dorama: ["dorama"], anime: ["anime"], turca: ["novelaturca", "diziturca"], variedades: ["variedades", "coreia"], trending: ["series"], movies: ["filmes", "cinema"], other: [] },
  },
  en: {
    code: "en", tmdbLang: "en-US", region: "US", tz: "America/New_York", intl: "en-US",
    titleLangs: [["en", "US"], ["en", null]],
    googleWhere: "where to watch", gl: "us", hl: "en",
    kinds: {
      premiere: { tag: "PREMIERE", label: "Premiere" },
      season: { tag: "NEW SEASON", label: "New season" },
      episode: { tag: "NEW EPISODE", label: "New episode" },
      streaming: { tag: "OUT NOW", label: "Premiered" },
      movie: { tag: "IN THEATERS", label: "In theaters" },
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
      streaming: ({ title }) => `${title} is out now.`,
      movie: ({ title, when }) => `${title} hits theaters ${when}.`,
    },
    theaters: "In theaters",
    whereCaption: " Where to watch: ",
    tail: "Will you watch? Tell us 👇 Link in bio.",
    tailTrending: "Are you watching? Tell us 👇 Link in bio.",
    warnPlatform: "Η πλατφόρμα δεν είναι ακόμα επιβεβαιωμένη στο TMDB — έλεγξε πριν ποστάρεις.",
    warnOverview: "Δεν υπάρχει αγγλική περίληψη.",
    labels: { kdrama: "K-drama", cdrama: "C-drama", dorama: "Asian drama", anime: "Anime", turca: "Turkish drama", variedades: "K-variety", trending: "Trending", movies: "Movies", other: "Series" },
    tags: { kdrama: ["kdrama"], cdrama: ["cdrama"], dorama: ["asiandrama"], anime: ["anime"], turca: ["turkishdrama", "dizi"], variedades: ["kvariety", "korea"], trending: ["tvshows"], movies: ["movies", "cinema"], other: [] },
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

// The caption in three pieces, so the page can offer the synopsis as an option.
function captionParts({ title, when, platforms, overview, tags, kind = "premiere", season, episode, L = LANGS.pt, trending = false }) {
  const where = platforms.length ? `${L.whereCaption}${platforms.join(", ")}.` : "";
  const head = `${captionHead({ title, when, kind, season, episode, L })}${where}`;
  const tail = `\n\n${trending ? L.tailTrending : L.tail}\n${tags.map((t) => `#${t}`).join(" ")}`;

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
  return { head, synopsis, tail };
}

function buildCaption(args) {
  const { head, synopsis, tail } = captionParts(args);
  return `${head}${synopsis ? ` ${synopsis}` : ""}${tail}`;
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
  const when = ev.kind === "streaming" ? "" : whenText(date, today, L);
  const title = pickTitle(detail, L);
  const tags = [...L.tags[category.key]];
  const titleTag = slugTag(title);
  // A hashtag cut in the middle of a word looks broken, so very long titles get none.
  if (titleTag && titleTag.length <= 24) tags.push(titleTag);
  const platformTag = category.key === "movies" ? "" : slugTag(platforms[0]);
  if (platformTag) tags.push(platformTag);

  const warnings = [];
  if (!platforms.length && ev.kind !== "movie") warnings.push(L.warnPlatform);
  if (!detail.overview) warnings.push(L.warnOverview);

  const args = { title, when, kind: ev.kind, season: ev.season, episode: ev.episode, L };
  const cp = captionParts({ ...args, platforms, overview: detail.overview, tags, trending: category.key === "trending" });
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
    episodes: (ev.kind === "premiere" || ev.kind === "streaming") && detail.number_of_episodes > 2 ? detail.number_of_episodes : null,
    // TMDB's own numbers. Very new titles have few or no votes, so the rating is only
    // shown once there are enough votes to mean something; popularity is always present.
    genreIds: (detail.genres || []).map((g) => g.id),
    popularity: Math.round((detail.popularity || 0) * 10) / 10,
    rating: detail.vote_count >= 5 ? Math.round(detail.vote_average * 10) / 10 : null,
    votes: detail.vote_count || 0,
    posterUrl: detail.poster_path ? `${IMG_BASE}/w780${detail.poster_path}` : null,
    captionHead: captionHead(args),
    // TMDB's synopsis is a machine-picked first sentence and can be a bad hook out of context
    // (e.g. an illness), so the default caption leaves it out; the page has a checkbox to add it.
    caption: `${cp.head}${cp.tail}`,
    synopsis: cp.synopsis,
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

// Upcoming theatrical releases in the audience's region. TMDB's release_dates tells the real
// date per country and type (2 limited, 3 theatrical); the card says "in theaters" because
// where a film streams is usually unknown until later.
const MOVIES = { key: "movies", exclude: [] };
async function loadMovies(today, until, L) {
  const found = await tmdbGet(`/discover/movie?language=${L.tmdbLang}&region=${L.region}&sort_by=popularity.desc&with_release_type=2|3&release_date.gte=${today}&release_date.lte=${until}`);
  const picks = (found.results || []).slice(0, PER_CATEGORY);
  const items = await mapPool(picks, 8, async (r) => {
    try {
      const d = await tmdbGet(`/movie/${r.id}?language=${L.tmdbLang}&append_to_response=release_dates,translations`);
      const entry = (d.release_dates?.results || []).find((x) => x.iso_3166_1 === L.region);
      // Theatrical dates in this region, all of them (not just the window). If the first one is
      // already in the past this is a re-release or a film that is already out: not news.
      const all = (entry?.release_dates || [])
        .filter((x) => (x.type === 2 || x.type === 3) && x.release_date)
        .map((x) => x.release_date.slice(0, 10))
        .sort();
      if (!all.length || all[0] < today || all[0] > until) return null;
      const dates = [all[0]];
      // Same shape as a series, so the shared title, caption and card code applies.
      const asShow = {
        ...d,
        name: d.title,
        original_name: d.original_title,
        first_air_date: dates[0],
        origin_country: (d.production_countries || []).map((c) => c.iso_3166_1),
        translations: { translations: (d.translations?.translations || []).map((t) => ({ ...t, data: { ...t.data, name: t.data?.title } })) },
        "watch/providers": { results: { [L.region]: { flatrate: [{ provider_name: L.theaters, display_priority: 1 }] } } },
      };
      return toItem(asShow, MOVIES, today, { kind: "movie", date: dates[0] }, L);
    } catch (e) { console.error(`release-cards: skipped movie ${r.id}:`, e.message); return null; }
  });
  return items.filter((i) => i && LATIN_ONLY.test(i.title));
}

// What people are watching this week (TMDB's global weekly trending list). Only titles with
// something to say on the card: an episode or a premiere in the window, or a very recent release.
// Titles that already belong to one of the Asian lists are left to those lists.
const TRENDING = { key: "trending", exclude: [10763, 10766, 10767] };
const OWN_LIST_COUNTRIES = ["KR", "CN", "JP", "TH", "TW", "TR"];
async function loadTrending(today, until, L) {
  const t = await tmdbGet(`/trending/tv/week?language=${L.tmdbLang}`);
  const picks = (t.results || []).slice(0, 20);
  const recent = addDays(today, -21);
  const items = await mapPool(picks, 8, async (r) => {
    try {
      if ((r.origin_country || []).some((c) => OWN_LIST_COUNTRIES.includes(c))) return null;
      const d = await tmdbGet(`/tv/${r.id}?language=${L.tmdbLang}&append_to_response=watch/providers,translations`);
      const ne = d.next_episode_to_air;
      if (ne && ne.air_date && ne.season_number >= 1 && ne.air_date >= today && ne.air_date <= until) {
        const kind = ne.episode_number === 1 && ne.season_number > 1 ? "season" : "episode";
        return toItem(d, TRENDING, today, { kind, date: ne.air_date, season: ne.season_number, episode: ne.episode_number }, L);
      }
      if (d.first_air_date && d.first_air_date >= today && d.first_air_date <= until) {
        return toItem(d, TRENDING, today, { kind: "premiere", date: d.first_air_date }, L);
      }
      if (d.first_air_date && d.first_air_date >= recent && d.first_air_date < today) {
        return toItem(d, TRENDING, today, { kind: "streaming", date: d.first_air_date }, L);
      }
      return null;
    } catch (e) { console.error(`release-cards: skipped trending ${r.id}:`, e.message); return null; }
  });
  return items.filter((i) => i && LATIN_ONLY.test(i.title) && !TRENDING.exclude.some((g) => i.genreIds.includes(g)));
}

// Which of our categories a title belongs to, from TMDB's own country and genre data
// (used by the title search, where the title did not come out of a category list).
function categoryFor(detail) {
  const c = detail.origin_country || [];
  const g = (detail.genres || []).map((x) => x.id);
  if (c.includes("JP") && g.includes(16)) return CATEGORIES.find((x) => x.key === "anime");
  if (c.includes("KR") && (g.includes(10764) || g.includes(10767))) return CATEGORIES.find((x) => x.key === "variedades");
  if (c.includes("KR")) return CATEGORIES.find((x) => x.key === "kdrama");
  if (c.includes("CN")) return CATEGORIES.find((x) => x.key === "cdrama");
  if (c.includes("TR")) return CATEGORIES.find((x) => x.key === "turca");
  if (c.some((x) => ["JP", "TH", "TW"].includes(x))) return CATEGORIES.find((x) => x.key === "dorama");
  return { key: "other" };
}

// One TMDB title -> a card item, whatever its state: upcoming premiere, upcoming
// season/episode, or already out ("now streaming").
function itemForTitle(d, today, L) {
  const category = categoryFor(d);
  const ne = d.next_episode_to_air;
  if (d.first_air_date && d.first_air_date >= today) {
    return toItem(d, category, today, { kind: "premiere", date: d.first_air_date }, L);
  }
  if (ne && ne.air_date && ne.air_date >= today && ne.season_number >= 1) {
    const kind = ne.episode_number === 1 && ne.season_number > 1 ? "season" : "episode";
    return toItem(d, category, today, { kind, date: ne.air_date, season: ne.season_number, episode: ne.episode_number }, L);
  }
  if (!d.first_air_date) return null;
  return toItem(d, category, today, { kind: "streaming", date: d.first_air_date }, L);
}

const searchCache = new Map(); // `${lang}:${query}` -> { data, expiresAt }
const SEARCH_TTL_MS = 60 * 60 * 1000;
const SEARCH_MAX_ENTRIES = 200;

async function searchTitles(query, langCode = DEFAULT_LANG) {
  const L = getLang(langCode);
  const q = String(query || "").trim().slice(0, 100);
  if (q.length < 2) return { query: q, lang: L.code, items: [], ui: uiFor(L) };
  const key = `${L.code}:${q.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;

  const today = todayIn(L.tz);
  const found = await tmdbGet(`/search/tv?language=${L.tmdbLang}&query=${encodeURIComponent(q)}&include_adult=false`);
  const picks = (found.results || []).slice(0, 6);
  const items = (await Promise.all(picks.map(async (r) => {
    try {
      const d = await tmdbGet(`/tv/${r.id}?language=${L.tmdbLang}&append_to_response=watch/providers,translations`);
      return itemForTitle(d, today, L);
    } catch (e) {
      console.error(`release-cards: search skipped ${r.id}:`, e.message);
      return null;
    }
  }))).filter(Boolean);

  const data = { query: q, lang: L.code, today, items, ui: uiFor(L) };
  if (searchCache.size >= SEARCH_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(key, { data, expiresAt: Date.now() + SEARCH_TTL_MS });
  return data;
}

function uiFor(L) {
  // Text the page needs for the card image and the Google link (so the client has no language of its own).
  return { ...L.ui, whereCaption: L.whereCaption, googleWhere: L.googleWhere, gl: L.gl, hl: L.hl };
}

async function buildReleaseCards(days, L) {
  const today = todayIn(L.tz);
  const until = addDays(today, days);
  const settled = await Promise.all(
    [...CATEGORIES.map((c) => loadCategory(c, today, until, L)), loadTrending(today, until, L), loadMovies(today, until, L)].map((p) => p.catch((e) => {
      console.error(`release-cards: category failed:`, e.message);
      return [];
    }))
  );
  // Titles with a confirmed platform first (they are the ones you can post without checking),
  // then by date.
  const items = settled.flat().sort((a, b) =>
    (b.platforms.length > 0) - (a.platforms.length > 0) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return {
    generatedAt: new Date().toISOString(), today, days, lang: L.code, region: L.region, items,
    ui: uiFor(L),
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

  app.get("/tools/release-cards-search.json", asyncHandler(async (req, res) => {
    try {
      const data = await searchTitles(req.query.q, req.query.lang === "en" ? "en" : "pt");
      res.setHeader("Cache-Control", "no-store");
      res.json(data);
    } catch (e) {
      console.error("release-cards search failed:", e.message);
      res.status(503).json({ error: "Could not search right now. Try again in a minute." });
    }
  }));

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
