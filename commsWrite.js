// commsWrite.js
// Write side of the CommsUni integration: post / reply / delete, like, spoiler
// mark, report, block, and the user's identity choice. Every write is made
// from here with the user's own actor ID; the app never talks to CommsUni.
const crypto = require("crypto");
const { getPool } = require("./db");
const { getUserDisplayInfo } = require("./db");
const { isConfigured, actorIdFor, commsRequest } = require("./commsuni");
const { tvdbIdForShow } = require("./commsBoard");
const { moderateComment } = require("./commsModeration");
const store = require("./commsStore");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const REPORT_REASONS = new Set(["spam", "abuse", "spoiler", "sexual", "illegal", "other", "mine_hide", "mine_claim"]);

// Small in-memory limiter — also protects our CommsUni write_units meter.
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}

function fail(res, status, error, code) {
  return res.status(status).json({ error, ...(code ? { code } : {}) });
}

// Upstream failure -> safe message. Real details go to the log only.
function upstreamFail(res, r, label) {
  console.error(`CommsUni ${label} failed:`, r.status, r.error?.code, r.error?.message, r.error?.reason || "");
  const code = r.error?.code;
  if (r.status === 429) return fail(res, 429, "Comments are busy right now. Try again in a moment.", "busy");
  if (code === "archive_writes_maintenance") return fail(res, 503, "Posting is paused for maintenance. Try again later.", "maintenance");
  if (r.status === 404) return fail(res, 404, "That comment is no longer available.", "not_found");
  if (r.status >= 400 && r.status < 500) return fail(res, 400, "Couldn't complete that.", "rejected");
  return fail(res, 502, "Comments are temporarily unavailable.", "unavailable");
}

function idemKey(req, res) {
  const k = String(req.get("Idempotency-Key") || "");
  if (!UUID_RE.test(k)) { fail(res, 400, "Missing Idempotency-Key"); return null; }
  return k;
}

// The identity CommsUni will show for this user. Opt-in only: until the user
// has chosen, writes are refused (identity_not_chosen).
async function syncIdentity(userId, actorId) {
  const profile = await store.getProfile(userId);
  if (!profile) return { ok: false, code: "identity_not_chosen" };
  if (!profile.share_identity) {
    if (profile.synced_hash) {
      const r = await commsRequest("/authors/me/profile", { method: "DELETE", actorId });
      if (r.ok) await store.setProfile(userId, { synced_hash: null });
    }
    return { ok: true };
  }
  const info = await getUserDisplayInfo(userId);
  const displayName = String(info?.display_name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 64) || "Scenera user";
  const avatar = info?.avatar_url && /^https:\/\//i.test(info.avatar_url) ? info.avatar_url : null;
  const hash = crypto.createHash("sha256").update(`${displayName}|${avatar || ""}`).digest("hex");
  if (profile.synced_hash === hash) return { ok: true };
  let r = await commsRequest("/authors/me/profile", { method: "PUT", actorId, body: { displayName, avatarUrl: avatar } });
  if (!r.ok && avatar && r.error?.code === "invalid_avatar_url") {
    r = await commsRequest("/authors/me/profile", { method: "PUT", actorId, body: { displayName, avatarUrl: null } });
  }
  if (!r.ok) return { ok: false, upstream: r };
  await store.setProfile(userId, { synced_hash: hash });
  return { ok: true };
}

async function episodeContext(episodeId) {
  const { rows } = await getPool().query(
    `select s.tmdb_id as show_tmdb_id, s.title as show_title, e.title as episode_title, e.season_number, e.episode_number
     from episodes e join shows s on s.id = e.show_id where e.id = $1`, [episodeId]);
  return rows[0] || null;
}

function mountCommsWrite(app, { requireAuth, asyncHandler }) {
  const ready = (req, res, next) => {
    if (!isConfigured() || !process.env.COMMS_ACTOR_SECRET) return fail(res, 503, "Comments are not available.");
    next();
  };
  // Posting, liking, marking spoilers, profile changes: blocked for suspended users.
  // Report, Block and own-comment delete stay available on purpose.
  const notSuspended = asyncHandler(async (req, res, next) => {
    if (await store.isSuspended(req.userId)) return fail(res, 403, "Your commenting access is suspended.", "suspended");
    next();
  });

  // ---- identity -------------------------------------------------------
  app.get("/comms/me", requireAuth, ready, asyncHandler(async (req, res) => {
    const profile = await store.getProfile(req.userId);
    const info = await getUserDisplayInfo(req.userId);
    res.json({
      identityChosen: Boolean(profile),
      shareIdentity: profile ? profile.share_identity : null,
      displayName: info?.display_name || null,
      suspended: await store.isSuspended(req.userId),
    });
  }));

  app.put("/comms/me/identity", requireAuth, ready, notSuspended, asyncHandler(async (req, res) => {
    if (typeof req.body?.share !== "boolean") return fail(res, 400, "share must be true or false");
    if (rateLimited(`ident:${req.userId}`, 10, 60 * 60 * 1000)) return fail(res, 429, "Too many changes. Try again later.");
    await store.setProfile(req.userId, { share_identity: req.body.share });
    const r = await syncIdentity(req.userId, actorIdFor(req.userId));
    if (!r.ok) return r.upstream ? upstreamFail(res, r.upstream, "profile sync") : fail(res, 400, "Couldn't update.");
    res.json({ shareIdentity: req.body.share });
  }));

  // ---- posting --------------------------------------------------------
  async function post(req, res, { kind, path, extra }) {
    const key = idemKey(req, res); if (!key) return;
    if (rateLimited(`post:${req.userId}`, 5, 60 * 1000) || rateLimited(`postday:${req.userId}`, 60, 24 * 60 * 60 * 1000)) {
      return fail(res, 429, "You're posting too fast. Take a breath and try again in a minute.", "slow_down");
    }
    const mod = await moderateComment(req.body?.text);
    if (!mod.ok) return fail(res, 422, mod.reason, "moderation");
    // One plain language tag: the client's if it sent one, else what moderation detected; otherwise omitted (stored as unknown).
    const language = req.body?.language && LANG_RE.test(String(req.body.language)) ? String(req.body.language).toLowerCase() : (mod.language || undefined);

    const actorId = actorIdFor(req.userId);
    const ident = await syncIdentity(req.userId, actorId);
    if (!ident.ok) {
      if (ident.code) return fail(res, 409, "Choose how your name appears first.", ident.code);
      return upstreamFail(res, ident.upstream, "profile sync");
    }

    const body = { text: mod.text, isSpoiler: req.body?.isSpoiler === true, ...(language ? { language } : {}), ...(extra?.entity ? { entity: extra.entity } : {}) };
    const r = await commsRequest(path, { method: "POST", actorId, idempotencyKey: key, body });
    if (!r.ok) return upstreamFail(res, r, kind);
    const comment = r.data?.comment;
    if (comment?.userId) {
      const p = await store.getProfile(req.userId);
      if (p && p.author_id !== comment.userId) await store.setProfile(req.userId, { author_id: comment.userId });
    }
    await store.logWrite(req.userId, kind, comment?.id, mod.text);
    res.status(201).json({ comment: comment ? { ...comment, mine: true } : null });
  }

  app.post("/comms/episodes/:episodeId/comments", requireAuth, ready, notSuspended, asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.episodeId)) return fail(res, 400, "invalid episode id");
    const ctx = await episodeContext(req.params.episodeId);
    if (!ctx) return fail(res, 404, "episode not found");
    const tvdbId = await tvdbIdForShow(ctx.show_tmdb_id);
    if (!tvdbId) return fail(res, 409, "Shared comments aren't available for this show.", "no_tvdb");
    const ref = `tvdb-${tvdbId}-s${ctx.season_number}e${ctx.episode_number}`;
    await post(req, res, {
      kind: "comment",
      path: `/entities/episode/${ref}/comments`,
      extra: { entity: { title: ctx.episode_title || `S${ctx.season_number}E${ctx.episode_number}`, showTitle: ctx.show_title } },
    });
  }));

  app.post("/comms/comments/:id/replies", requireAuth, ready, notSuspended, asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 400, "invalid comment id");
    await post(req, res, { kind: "reply", path: `/comments/${req.params.id}/replies` });
  }));

  app.delete("/comms/comments/:id", requireAuth, ready, asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 400, "invalid comment id");
    const r = await commsRequest(`/comments/${req.params.id}`, { method: "DELETE", actorId: actorIdFor(req.userId) });
    if (!r.ok) return upstreamFail(res, r, "delete");
    await store.logWrite(req.userId, "delete", req.params.id);
    res.json({ ok: true });
  }));

  // ---- engagement -----------------------------------------------------
  function toggle(kind) {
    return asyncHandler(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) return fail(res, 400, "invalid comment id");
      if (rateLimited(`eng:${req.userId}`, 60, 60 * 1000)) return fail(res, 429, "Slow down a little.", "slow_down");
      const on = req.method === "PUT";
      const r = await commsRequest(`/comments/${req.params.id}/${kind}`, { method: on ? "PUT" : "DELETE", actorId: actorIdFor(req.userId) });
      if (!r.ok) return upstreamFail(res, r, kind);
      res.json({ [kind === "like" ? "liked" : "marked"]: on });
    });
  }
  app.put("/comms/comments/:id/like", requireAuth, ready, notSuspended, toggle("like"));
  app.delete("/comms/comments/:id/like", requireAuth, ready, notSuspended, toggle("like"));
  app.put("/comms/comments/:id/spoiler", requireAuth, ready, notSuspended, toggle("spoiler"));
  app.delete("/comms/comments/:id/spoiler", requireAuth, ready, notSuspended, toggle("spoiler"));

  // ---- moderation: report + block ------------------------------------
  app.post("/comms/comments/:id/reports", requireAuth, ready, asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 400, "invalid comment id");
    const key = idemKey(req, res); if (!key) return;
    const reason = String(req.body?.reason || "");
    if (!REPORT_REASONS.has(reason)) return fail(res, 400, "invalid reason");
    if (rateLimited(`report:${req.userId}`, 20, 60 * 60 * 1000)) return fail(res, 429, "Too many reports. Try again later.");
    const detail = req.body?.detail ? String(req.body.detail).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 1000) : "";
    const r = await commsRequest(`/comments/${req.params.id}/reports`, {
      method: "POST", actorId: actorIdFor(req.userId), idempotencyKey: key,
      body: { reason, ...(detail ? { detail } : {}) },
    });
    if (!r.ok) return upstreamFail(res, r, "report");
    res.status(202).json({ ok: true, duplicate: r.headers.reportDuplicate === "true" });
  }));

  app.get("/comms/blocks", requireAuth, asyncHandler(async (req, res) => {
    res.json({ blocks: (await store.listBlocks(req.userId)).map((b) => ({ authorId: b.author_id, name: b.author_name })) });
  }));
  app.post("/comms/blocks", requireAuth, asyncHandler(async (req, res) => {
    const authorId = String(req.body?.authorId || "");
    if (!UUID_RE.test(authorId)) return fail(res, 400, "invalid author id");
    await store.addBlock(req.userId, authorId, req.body?.name);
    res.json({ ok: true });
  }));
  app.delete("/comms/blocks/:authorId", requireAuth, asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.authorId)) return fail(res, 400, "invalid author id");
    await store.removeBlock(req.userId, req.params.authorId);
    res.json({ ok: true });
  }));
}

module.exports = { mountCommsWrite };
