// tmdbProxy.js
// GET /tmdb/<tmdb path>?<tmdb query> — a pass-through to TMDB using the server's key.
//
// Why: the app normally calls TMDB straight from the phone. For some people (observed from Russia:
// "Failed to fetch (api.themoviedb.org)") that connection fails, and then search and every show page
// stay empty. The app now retries through here when the direct call fails at the network level, and the
// backend (Render) can reach TMDB. Only the paths the app actually uses are allowed, so this cannot be
// used as an open TMDB relay.
//
// Answers are remembered for 5 minutes, so the same search or the same show opened by several people in
// a row is served from memory instead of asking TMDB again. Only successful answers are kept.

const { throttle } = require("./tmdbThrottle");

const TMDB_BASE = "https://api.themoviedb.org/3";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500; // keeps memory bounded: the oldest entry goes when full
const MAX_QUERY_LENGTH = 600;
const REQUEST_TIMEOUT_MS = 10_000;

const ALLOWED_PATHS = [
  /^\/search\/(tv|movie|multi)$/,
  /^\/(tv|movie)\/\d+$/,
  /^\/tv\/\d+\/(recommendations|similar)$/,
  /^\/tv\/\d+\/season\/\d+$/,
  /^\/tv\/\d+\/season\/\d+\/episode\/\d+\/credits$/,
  /^\/collection\/\d+$/,
  /^\/discover\/(tv|movie)$/,
  /^\/trending\/(tv|movie)\/week$/,
  /^\/(tv|movie)\/popular$/,
  /^\/movie\/upcoming$/,
];

const cache = new Map(); // key -> { data, expiresAt }

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(key); return null; }
  return hit.data;
}

function writeCache(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function tmdbProxy(req, res) {
  const path = "/" + String(req.params[0] || "").replace(/^\/+/, "");
  if (!ALLOWED_PATHS.some((re) => re.test(path))) return res.status(404).json({ error: "Not found" });

  // The client's own api_key (if any) is never forwarded; the server's key is used instead.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "api_key" || typeof v !== "string") continue;
    params.append(k, v);
  }
  params.sort();
  const query = params.toString();
  if (query.length > MAX_QUERY_LENGTH) return res.status(414).json({ error: "Query too long" });

  const cacheKey = `${path}?${query}`;
  const cached = readCache(cacheKey);
  if (cached) return res.json(cached);

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "TMDB is not configured" });
  params.append("api_key", apiKey);
  const url = `${TMDB_BASE}${path}?${params.toString()}`;

  let upstream;
  try {
    upstream = await throttle(() => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  } catch (e) {
    return res.status(502).json({ error: "TMDB unreachable" });
  }
  if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).json({ error: `TMDB responded ${upstream.status}` });

  const data = await upstream.json();
  writeCache(cacheKey, data);
  res.json(data);
}

module.exports = { tmdbProxy };
