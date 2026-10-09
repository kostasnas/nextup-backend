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
const PER_CATEGORY = 6;
const TWEET_LIMIT = 270; // X allows 280; leave headroom (emoji count double)

const CATEGORIES = [
  { key: "kdrama", label: "K-drama", params: "with_origin_country=KR&without_genres=16", tags: ["dorama", "kdrama"] },
  { key: "dorama", label: "Dorama", params: "with_origin_country=JP|CN|TH|TW&without_genres=16", tags: ["dorama"] },
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

function buildCaption({ title, when, platforms, overview, tags }) {
  const where = platforms.length ? ` Onde assistir: ${platforms.join(", ")}.` : "";
  const head = `${title} estreia ${when}.${where}`;
  const tail = `\n\nVai ver? Conta pra gente 👇 Link na bio.\n${tags.map((t) => `#${t}`).join(" ")}`;

  let synopsis = firstSentence(overview);
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
  const flat = detail["watch/providers"]?.results?.[REGION]?.flatrate || [];
  const sorted = [...flat].sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));
  const names = [];
  for (const p of sorted) {
    if (p.provider_name && !names.includes(p.provider_name)) names.push(p.provider_name);
  }
  return names.slice(0, 2);
}

function toItem(detail, category, today) {
  const date = detail.first_air_date;
  const platforms = pickPlatforms(detail);
  const when = whenPt(date, today);
  const title = detail.name || detail.original_name;
  const tags = [...category.tags];
  const titleTag = slugTag(title);
  // A hashtag cut in the middle of a word looks broken, so very long titles get none.
  if (titleTag && titleTag.length <= 24) tags.push(titleTag);
  const platformTag = slugTag(platforms[0]);
  if (platformTag) tags.push(platformTag);

  const warnings = [];
  if (!platforms.length) warnings.push("Plataforma ainda não confirmada no TMDB — verifique antes de postar.");
  if (!detail.overview) warnings.push("Sem sinopse em português.");

  return {
    id: detail.id,
    title,
    category: category.key,
    categoryLabel: category.label,
    date,
    daysFromToday: daysBetween(today, date),
    when,
    dateLong: longDatePt(date),
    platforms,
    episodes: detail.number_of_episodes > 0 ? detail.number_of_episodes : null,
    posterUrl: detail.poster_path ? `${IMG_BASE}/w780${detail.poster_path}` : null,
    caption: buildCaption({ title, when, platforms, overview: detail.overview, tags }),
    warnings,
  };
}

async function loadCategory(category, today, until) {
  const list = await tmdbGet(
    `/discover/tv?language=${LANG}&sort_by=popularity.desc&include_null_first_air_dates=false` +
    `&first_air_date.gte=${today}&first_air_date.lte=${until}&${category.params}`
  );
  const picks = (list.results || []).slice(0, PER_CATEGORY);
  const items = [];
  for (const r of picks) {
    try {
      const detail = await tmdbGet(`/tv/${r.id}?language=${LANG}&append_to_response=watch/providers`);
      if (!detail.first_air_date) continue;
      items.push(toItem(detail, category, today));
    } catch (e) {
      console.error(`release-cards: skipped ${category.key} ${r.id}:`, e.message);
    }
  }
  return items;
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
  const items = settled.flat().sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
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

module.exports = { mountReleaseCards, getReleaseCards, buildCaption, whenPt, todayInBrazil, slugTag };
