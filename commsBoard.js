// commsBoard.js
// Read side of the CommsUni shared comments board, exposed to our own app.
// The app never talks to api.commsuni.tv and never sees the API key — it calls
// these routes, which resolve our TMDB ids to the TVDB references the API uses,
// attach the per-user actor ID, and relay the result.
const { getPool } = require("./db");
const { throttle } = require("./tmdbThrottle");
const { isConfigured, actorIdFor, commsRequest } = require("./commsuni");
const store = require("./commsStore");
const { tvdbIdForMovie } = require("./tvdbMovie");

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
const LANG_TAG = "(?:unknown|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)";
const LANG_LIST_RE = new RegExp(`^${LANG_TAG}(?:,${LANG_TAG}){0,11}$`, "i");
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

  // Signed image URLs for archive comments. Each granted URL is charged against our
  // media_grants meter, so the app only asks for images the user chose to open, and
  // we never store the (short-lived) URLs.
  const grantHits = new Map();
  app.post("/comms/media-grants", requireAuth, asyncHandler(async (req, res) => {
    if (!isConfigured() || !process.env.COMMS_ACTOR_SECRET) return res.status(503).json({ error: "Comments are not available." });
    const ids = Array.isArray(req.body?.commentIds) ? [...new Set(req.body.commentIds.map(String))] : [];
    if (ids.length < 1 || ids.length > 16 || !ids.every((i) => UUID_RE.test(i))) return res.status(400).json({ error: "invalid commentIds" });
    const now = Date.now();
    const recent = (grantHits.get(req.userId) || []).filter((t) => now - t < 60000);
    if (recent.length >= 30) return res.status(429).json({ error: "Too many images requested. Try again in a moment." });
    recent.push(now); grantHits.set(req.userId, recent);
    const r = await commsRequest("/media-grants", { method: "POST", actorId: actorIdFor(req.userId), body: { commentIds: ids } });
    if (!r.ok) return sendUpstreamError(res, r, "media grants");
    res.set("Cache-Control", "private, no-store");
    res.json({
      grants: (r.data?.grants || []).map((g) => ({ commentId: g.commentId, status: g.status, url: g.url || null, contentType: g.contentType || null, width: g.width || null, height: g.height || null })),
    });
  }));

  // Shared by the episode and movie routes: validates the query, asks CommsUni for one
  // entity's conversation and applies our per-user layer (blocked authors, "mine").
  // `getEntityPath` runs after the query is validated and returns "episode/tvdb-..." or
  // "movie/tvdb-...", or null when the shared board can't address this title.
  async function serveBoard(req, res, label, getEntityPath) {
    if (!isConfigured() || !process.env.COMMS_ACTOR_SECRET) return res.status(503).json({ error: "Comments are not available." });

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

    const entityPath = await getEntityPath();
    if (entityPath === undefined) return; // getEntityPath already sent its own error
    // No TVDB id: the shared board can't address this title. Tell the app so it can show a plain note.
    if (!entityPath) return res.json({ available: false, comments: [], nextCursor: null });

    const r = await commsRequest(`/entities/${entityPath}/comments?${params.toString()}`, { actorId: actorIdFor(req.userId) });
    if (r.status === 404) return res.json({ available: true, comments: [], nextCursor: null, empty: true });
    if (!r.ok) return sendUpstreamError(res, r, label);
    // Our own per-user layer: hide authors this user blocked (rows and inline replies),
    // and flag the user's own comments so the app can offer delete instead of report.
    const [blocked, profile] = await Promise.all([store.blockedAuthorIds(req.userId), store.getProfile(req.userId).catch(() => null)]);
    const myAuthorId = profile?.author_id || null;
    const decorate = (c) => ({ ...c, mine: Boolean(myAuthorId) && c.userId === myAuthorId });
    // Deleted comments can come back as tombstones (deleted: true, text: null). The API says to hide
    // them completely: no text, no placeholder card.
    const isLive = (c) => c && c.deleted !== true && !c.deletedAt;
    const comments = (r.data.comments || [])
      .filter((c) => isLive(c) && !blocked.has(c.userId))
      .map((c) => ({ ...decorate(c), replies: (c.replies || []).filter((x) => isLive(x) && !blocked.has(x.userId)).map(decorate) }));
    res.set("Cache-Control", "private, no-store");
    res.json({
      available: true,
      comments,
      nextCursor: r.data.nextCursor || null,
      sort: r.data.sort || sort,
      languageCounts: r.data.languageCounts || [],
      sourceCounts: r.data.sourceCounts || [],
    });
  }

  // One episode's shared conversation. Query: sort, source, language, cursor, limit.
  app.get("/comms/episodes/:episodeId/comments", requireAuth, asyncHandler(async (req, res) => {
    const { episodeId } = req.params;
    if (!UUID_RE.test(episodeId)) return res.status(400).json({ error: "invalid episode id" });
    await serveBoard(req, res, "episode comments", async () => {
      const { rows } = await getPool().query(
        `select s.tmdb_id as show_tmdb_id, e.season_number, e.episode_number
         from episodes e join shows s on s.id = e.show_id where e.id = $1`,
        [episodeId]
      );
      if (!rows[0]) { res.status(404).json({ error: "episode not found" }); return undefined; }
      const { show_tmdb_id, season_number, episode_number } = rows[0];
      const tvdbId = await tvdbIdForShow(show_tmdb_id);
      return tvdbId ? `episode/tvdb-${tvdbId}-s${season_number}e${episode_number}` : null;
    });
  }));

  // One movie's shared conversation (same query as episodes). The movie is addressed by its
  // TMDB id; we map it to the TVDB movie id the archive uses (see tvdbMovie.js).
  app.get("/comms/movies/:tmdbId/comments", requireAuth, asyncHandler(async (req, res) => {
    if (!/^\d{1,9}$/.test(req.params.tmdbId)) return res.status(400).json({ error: "invalid movie id" });
    const tmdbId = Number(req.params.tmdbId);
    await serveBoard(req, res, "movie comments", async () => {
      const tvdbId = await tvdbIdForMovie(tmdbId);
      return tvdbId ? `movie/tvdb-${tvdbId}` : null;
    });
  }));
}

module.exports = { mountComms, tvdbIdForShow };
