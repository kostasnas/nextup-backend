// commsBoard.js
// Read side of the CommsUni shared comments board, exposed to our own app.
// The app never talks to api.commsuni.tv and never sees the API key — it calls
// these routes, which resolve our TMDB ids to the TVDB references the API uses,
// attach the per-user actor ID, and relay the result.
const { getPool } = require("./db");
const { throttle } = require("./tmdbThrottle");
const { isConfigured, actorIdFor, commsRequest } = require("./commsuni");
const store = require("./commsStore");

const TMDB_BASE = "https://api.themoviedb.org/3";
const DAY_MS = 24 * 60 * 60 * 1000;

// tmdb show id -> tvdb show id (null when TMDB has none). Mapping is stable, so a long TTL is fine.
const tvdbCache = new Map();
async function tvdbIdForShow(tmdbId) {
  const hit = tvdbCache.get(tmdbId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const url = `${TMDB_BASE}/tv/${tmdbId}/external_ids?api_key=${process.env.TMDB_API_KEY}`;
  const data = await throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB external_ids failed: ${res.status}`);
    return res.json();
  });
  const value = data.tvdb_id ? String(data.tvdb_id) : null;
  tvdbCache.set(tmdbId, { value, expires: Date.now() + (value ? 7 * DAY_MS : DAY_MS) });
  return value;
}

let sourcesCache = null;
async function getSources() {
  if (sourcesCache && sourcesCache.expires > Date.now()) return sourcesCache.data;
  const r = await commsRequest("/sources", { actorId: "catalog" });
  if (!r.ok) throw Object.assign(new Error(r.error?.message || "sources failed"), { upstream: r });
  sourcesCache = { data: r.data, expires: Date.now() + DAY_MS };
  return r.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORTS = new Set(["most_liked", "most_recent", "most_relevant"]);
const SLUG_LIST_RE = /^[a-z0-9_-]+(,[a-z0-9_-]+){0,19}$/i;
const LANG_LIST_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?(,[a-z]{2,3}(-[a-z0-9]{2,8})?){0,7}$/i;
const CURSOR_RE = /^[A-Za-z0-9_\-=.]{1,2000}$/;

// Maps an upstream failure to something safe to show; the real message goes to the server log only.
function sendUpstreamError(res, r, label) {
  console.error(`CommsUni ${label} failed:`, r.status, r.error?.code, r.error?.message, r.error?.reason || "");
  if (r.status === 429) return res.status(429).json({ error: "Comments are busy right now. Try again in a moment." });
  return res.status(502).json({ error: "Comments are temporarily unavailable." });
}

function mountComms(app, { requireAuth, asyncHandler }) {
  app.get("/comms/status", requireAuth, (req, res) => {
    res.json({ enabled: isConfigured() && Boolean(process.env.COMMS_ACTOR_SECRET) });
  });

  app.get("/comms/sources", requireAuth, asyncHandler(async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ error: "Comments are not available." });
    try {
      res.json(await getSources());
    } catch (e) {
      if (e.upstream) return sendUpstreamError(res, e.upstream, "sources");
      throw e;
    }
  }));

  // One episode's shared conversation. Query: sort, source, language, cursor, limit.
  app.get("/comms/episodes/:episodeId/comments", requireAuth, asyncHandler(async (req, res) => {
    if (!isConfigured() || !process.env.COMMS_ACTOR_SECRET) return res.status(503).json({ error: "Comments are not available." });
    const { episodeId } = req.params;
    if (!UUID_RE.test(episodeId)) return res.status(400).json({ error: "invalid episode id" });

    const sort = req.query.sort ? String(req.query.sort) : "most_liked";
    if (!SORTS.has(sort)) return res.status(400).json({ error: "invalid sort" });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
    const params = new URLSearchParams({ sort, limit: String(limit), include: "source_counts,language_counts" });
    if (req.query.source) {
      if (!SLUG_LIST_RE.test(String(req.query.source))) return res.status(400).json({ error: "invalid source" });
      params.set("source", String(req.query.source));
    }
    if (req.query.language) {
      if (!LANG_LIST_RE.test(String(req.query.language))) return res.status(400).json({ error: "invalid language" });
      params.set("language", String(req.query.language));
    }
    if (req.query.cursor) {
      if (!CURSOR_RE.test(String(req.query.cursor))) return res.status(400).json({ error: "invalid cursor" });
      params.set("cursor", String(req.query.cursor));
    }

    const { rows } = await getPool().query(
      `select s.tmdb_id as show_tmdb_id, e.season_number, e.episode_number
       from episodes e join shows s on s.id = e.show_id where e.id = $1`,
      [episodeId]
    );
    if (!rows[0]) return res.status(404).json({ error: "episode not found" });
    const { show_tmdb_id, season_number, episode_number } = rows[0];

    const tvdbId = await tvdbIdForShow(show_tmdb_id);
    // No TVDB id: the shared board can't address this show. Tell the app so it can show a plain note.
    if (!tvdbId) return res.json({ available: false, comments: [], nextCursor: null });

    const ref = `tvdb-${tvdbId}-s${season_number}e${episode_number}`;
    const r = await commsRequest(`/entities/episode/${ref}/comments?${params.toString()}`, { actorId: actorIdFor(req.userId) });
    if (r.status === 404) return res.json({ available: true, comments: [], nextCursor: null, empty: true });
    if (!r.ok) return sendUpstreamError(res, r, "episode comments");
    // Our own per-user layer: hide authors this user blocked (rows and inline replies),
    // and flag the user's own comments so the app can offer delete instead of report.
    const [blocked, profile] = await Promise.all([store.blockedAuthorIds(req.userId), store.getProfile(req.userId).catch(() => null)]);
    const myAuthorId = profile?.author_id || null;
    const decorate = (c) => ({ ...c, mine: Boolean(myAuthorId) && c.userId === myAuthorId });
    const comments = (r.data.comments || [])
      .filter((c) => !blocked.has(c.userId))
      .map((c) => ({ ...decorate(c), replies: (c.replies || []).filter((x) => !blocked.has(x.userId)).map(decorate) }));
    res.json({
      available: true,
      comments,
      nextCursor: r.data.nextCursor || null,
      sort: r.data.sort || sort,
      languageCounts: r.data.languageCounts || [],
      sourceCounts: r.data.sourceCounts || [],
    });
  }));
}

module.exports = { mountComms, tvdbIdForShow };
