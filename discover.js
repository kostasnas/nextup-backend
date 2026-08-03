// discover.js
// Provider-aware "Top Shows" discovery, proxied through the backend
// so the TMDB key doesn't need to live in the client bundle for this
// feature — with a simple in-memory cache, since "Top Netflix shows
// in Greece" is identical for every user in that region, there's no
// reason to hit TMDB freshly per request.

const TMDB_BASE = "https://api.themoviedb.org/3";
const { throttle } = require("./tmdbThrottle");

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — provider catalogs and popularity lists don't meaningfully change minute to minute
const cache = new Map(); // key -> { data, expiresAt }

function getCached(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function tmdbGet(path) {
  const apiKey = process.env.TMDB_API_KEY;
  const url = `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey}`;
  return throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB request failed (${res.status})`);
    return res.json();
  });
}

/**
 * Returns the streaming providers TMDB considers "popular" for a
 * region — used to build the filter chips. Deliberately NOT
 * hardcoding provider IDs (Netflix=8 is stable, but others vary by
 * region/source), so the chips and their IDs always match what TMDB
 * actually recognizes right now.
 */
async function getWatchProviders(region = "US") {
  const cacheKey = `providers:${region}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await tmdbGet(`/watch/providers/tv?watch_region=${region}`);
  const providers = (data.results || [])
    .filter((p) => p.display_priorities && p.display_priorities[region] !== undefined)
    .sort((a, b) => (a.display_priorities[region] ?? 999) - (b.display_priorities[region] ?? 999))
    .slice(0, 10)
    .map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path }));

  setCached(cacheKey, providers);
  return providers;
}

/**
 * "Top shows" for a region, optionally filtered to a specific
 * streaming provider. watch_monetization_type=flatrate excludes
 * rent/buy-only titles — otherwise a "Netflix" filter could surface
 * shows only available to purchase there, not actually streamable
 * with a subscription.
 */
async function getTopShows({ region = "US", providerId = null } = {}) {
  const cacheKey = `top:${region}:${providerId || "all"}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = providerId
    ? await tmdbGet(`/discover/tv?watch_region=${region}&with_watch_providers=${providerId}&watch_monetization_type=flatrate&sort_by=popularity.desc`)
    : await tmdbGet(`/tv/popular`);

  const shows = (data.results || []).slice(0, 20);
  setCached(cacheKey, shows);
  return shows;
}

/**
 * Weekly trending shows — TMDB's own algorithm, not region-specific
 * (the endpoint doesn't accept a watch_region param), so a single
 * global cache entry serves every user regardless of country.
 */
async function getTrending() {
  const cacheKey = "trending";
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await tmdbGet(`/trending/tv/week`);
  const shows = (data.results || []).slice(0, 20);
  setCached(cacheKey, shows);
  return shows;
}

/**
 * The full TV genre list — essentially static (TMDB adds/renames
 * genres extremely rarely), so this is the safest thing to cache of
 * everything here. One global entry, same 12h TTL as the rest for
 * simplicity rather than a separate longer-lived cache.
 */
async function getGenres() {
  const cacheKey = "genres";
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await tmdbGet(`/genre/tv/list`);
  const genres = data.genres || [];
  setCached(cacheKey, genres);
  return genres;
}

module.exports = { getWatchProviders, getTopShows, getTrending, getGenres };
