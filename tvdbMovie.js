// tvdbMovie.js
// TMDB movie id -> TVDB movie id, for the shared CommsUni comments on movies.
//
// CommsUni addresses a movie as `movie/tvdb-<TVDB movie id>`, and TMDB does not
// give a TVDB id for movies (it does for shows). Wikidata links the two: TMDB's
// external_ids returns the movie's Wikidata id, and that Wikidata item carries
// "TheTVDB.com movie ID" when someone has filled it in. Free, no key, but
// coverage is not 100% — a movie without it simply has no shared board (the app
// shows the same plain note it shows for shows without a TVDB id).
//
// The Wikidata property id is looked up once by its English label rather than
// hardcoded, so a wrong memory of the number can't break this. If that lookup
// ever picks the wrong property, set WIKIDATA_TVDB_MOVIE_PROP (e.g. "P12196")
// in the environment to override it.

const { throttle } = require("./tmdbThrottle");

const TMDB_BASE = "https://api.themoviedb.org/3";
const WD_API = "https://www.wikidata.org/w/api.php";
const WD_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData/";
const UA = "Scenera/1.0 (https://scenera.online; movie id mapping)";
const DAY_MS = 24 * 60 * 60 * 1000;

async function wdJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Wikidata request failed (${res.status})`);
  return res.json();
}

let propCache = null; // { id, expires }
async function tvdbMovieProperty() {
  if (process.env.WIKIDATA_TVDB_MOVIE_PROP) return process.env.WIKIDATA_TVDB_MOVIE_PROP;
  if (propCache && propCache.expires > Date.now()) return propCache.id;
  const url = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent("TheTVDB.com movie ID")}&type=property&language=en&limit=10&format=json`;
  const json = await wdJson(url);
  const hit = (json.search || []).find((p) => /tvdb/i.test(p.label || "") && /movie|film/i.test(p.label || ""));
  const id = hit?.id || null;
  propCache = { id, expires: Date.now() + (id ? 7 * DAY_MS : 60 * 60 * 1000) };
  return id;
}

async function wikidataIdForMovie(tmdbId) {
  const url = `${TMDB_BASE}/movie/${tmdbId}/external_ids?api_key=${process.env.TMDB_API_KEY}`;
  const data = await throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB external_ids failed: ${res.status}`);
    return res.json();
  });
  return data.wikidata_id || null;
}

// Picks the TVDB id out of a Wikidata item's claims for one property.
function pickClaimValue(entity, prop) {
  const claims = (entity?.claims?.[prop] || []).filter((c) => c.rank !== "deprecated");
  claims.sort((a, b) => (b.rank === "preferred") - (a.rank === "preferred"));
  for (const c of claims) {
    const v = c.mainsnak?.datavalue?.value;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  }
  return null;
}

const cache = new Map(); // tmdbId -> { value, expires }

// Returns { tvdbId, qid, prop, reason }. `reason` says why there is no id
// (useful for the admin check); the app only needs tvdbId.
async function lookupMovieTvdb(tmdbId) {
  const qid = await wikidataIdForMovie(tmdbId);
  if (!qid) return { tvdbId: null, qid: null, prop: null, reason: "TMDB has no Wikidata id for this movie" };
  const prop = await tvdbMovieProperty();
  if (!prop) return { tvdbId: null, qid, prop: null, reason: "could not find the TVDB movie property on Wikidata" };
  const json = await wdJson(`${WD_ENTITY}${qid}.json`);
  const tvdbId = pickClaimValue(json.entities?.[qid], prop);
  return { tvdbId, qid, prop, reason: tvdbId ? "ok" : "the Wikidata item has no TVDB movie id" };
}

// Cached wrapper used by the comments routes. Mapping is stable: long TTL when
// found, a day when missing (Wikidata may be filled in later). Failures
// (network, rate limits) are never cached.
async function tvdbIdForMovie(tmdbId) {
  const hit = cache.get(tmdbId);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const { tvdbId } = await lookupMovieTvdb(tmdbId);
    cache.set(tmdbId, { value: tvdbId, expires: Date.now() + (tvdbId ? 30 * DAY_MS : DAY_MS) });
    return tvdbId;
  } catch (e) {
    console.error("TVDB movie id lookup failed:", tmdbId, e.message);
    return null;
  }
}

module.exports = { tvdbIdForMovie, lookupMovieTvdb };
