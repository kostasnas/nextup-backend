// rottenTomatoes.js
// Rotten Tomatoes score via OMDb (omdbapi.com) — Rotten Tomatoes has no
// public API of its own, so OMDb (which aggregates it) is the standard
// free way to get it. OMDb keys everything by IMDb ID, not TMDB ID, so
// this first resolves tmdbId -> imdbId via TMDB's external_ids, then
// queries OMDb with that. Both lookups are cached in-memory (same
// simple Map+TTL pattern as discover.js) since RT scores are
// effectively static once a title has enough reviews to have one, and
// there's no reason to spend OMDb's free-tier 1,000 requests/day quota
// re-fetching the same title for every viewer.
//
// Requires OMDB_API_KEY in the environment (Render -> Environment
// tab) — free key at https://www.omdbapi.com/apikey.aspx. Without the
// key set, this fails soft (returns null) rather than breaking Show/
// Movie Detail — Rotten Tomatoes is a nice-to-have badge, not
// something the rest of the page should ever depend on.

const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "https://www.omdbapi.com/";
const { throttle } = require("./tmdbThrottle");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const cache = new Map(); // key -> { data, expiresAt }

function getCached(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * mediaType is TMDB's own "tv" | "movie" path segment.
 * Returns "" (not null) when TMDB has no IMDb id for this title —
 * still a valid, cacheable answer, distinct from "haven't looked yet".
 */
async function getImdbId(tmdbId, mediaType) {
  const cacheKey = `imdbid:${mediaType}:${tmdbId}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  const apiKey = process.env.TMDB_API_KEY;
  const url = `${TMDB_BASE}/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`;
  const data = await throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB external_ids failed: ${res.status}`);
    return res.json();
  });
  const imdbId = data.imdb_id || "";
  setCached(cacheKey, imdbId);
  return imdbId;
}

/**
 * Returns { score, imdbRating, imdbId } — score/imdbRating are null
 * when unavailable (never thrown), so callers can render "no RT
 * rating" the same way whether that's because OMDB_API_KEY isn't set,
 * OMDb doesn't have the title, or it genuinely has no RT score yet.
 */
async function getRottenTomatoesRating(tmdbId, mediaType) {
  const omdbKey = process.env.OMDB_API_KEY;
  if (!omdbKey) return null; // not configured yet — see file header

  const resultCacheKey = `rt:${mediaType}:${tmdbId}`;
  const cachedResult = getCached(resultCacheKey);
  if (cachedResult !== null) return cachedResult;

  const imdbId = await getImdbId(tmdbId, mediaType);
  if (!imdbId) {
    const result = { score: null, imdbRating: null, imdbId: null };
    setCached(resultCacheKey, result);
    return result;
  }

  const url = `${OMDB_BASE}?i=${imdbId}&apikey=${omdbKey}`;
  const res = await fetch(url);
  if (!res.ok) return null; // OMDb hiccup — don't cache a transient failure, just retry next request

  const data = await res.json();
  if (data.Response === "False") {
    const result = { score: null, imdbRating: null, imdbId };
    setCached(resultCacheKey, result);
    return result;
  }

  const rtEntry = (data.Ratings || []).find((r) => r.Source === "Rotten Tomatoes");
  const result = {
    score: rtEntry ? rtEntry.Value : null, // e.g. "89%"
    imdbRating: data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null,
    imdbId,
  };
  setCached(resultCacheKey, result);
  return result;
}

module.exports = { getRottenTomatoesRating };
