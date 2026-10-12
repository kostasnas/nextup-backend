// commsuni.js
// Server-side client for the CommsUni.tv partner API (shared comments board).
// The API key is a server credential: it is read from COMMS_API_KEY and never
// leaves this process — the app only ever talks to our own backend.
// Every request carries an opaque per-user actor ID (HMAC of our user id) and an
// explicit header allowlist; the device's Origin header is never forwarded.
const crypto = require("crypto");

const BASE = process.env.COMMS_API_BASE || "https://api.commsuni.tv/v1";

function isConfigured() {
  return Boolean(process.env.COMMS_API_KEY);
}

// Opaque, stable, one-per-user identifier: hex HMAC-SHA256(secret, userId).
// COMMS_ACTOR_SECRET must stay constant forever, or every user's identity changes.
function actorIdFor(userId) {
  const secret = process.env.COMMS_ACTOR_SECRET;
  if (!secret) throw new Error("COMMS_ACTOR_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(String(userId)).digest("hex");
}

/**
 * One request to the partner API. Returns { status, ok, data, error, headers }.
 * `actorId` must already be derived server-side. Never throws on HTTP errors.
 */
async function commsRequest(path, { method = "GET", body, actorId, idempotencyKey, timeoutMs = 10000 } = {}) {
  if (!isConfigured()) throw new Error("COMMS_API_KEY is not set");
  const headers = {
    Authorization: `Bearer ${process.env.COMMS_API_KEY}`,
    Accept: "application/json",
  };
  if (actorId) headers["X-TVTA-Actor-ID"] = actorId;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; } }
    return {
      status: res.status,
      ok: res.ok,
      data: json && json.data !== undefined ? json.data : null,
      error: json && json.error ? json.error : null,
      headers: {
        rateLimitRemaining: res.headers.get("ratelimit-remaining"),
        rateLimitMetric: res.headers.get("x-ratelimit-metric"),
        replayed: res.headers.get("idempotency-replayed"),
        reportDuplicate: res.headers.get("report-duplicate"),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// Diagnostic used by GET /admin/comms-smoke. Uses the documented synthetic
// title (TVDB show 900000001) and the shared "smoke-test" actor, so nothing
// real is touched. Reports status codes only — never the key.
async function runSmokeTest({ write = false } = {}) {
  const out = { configured: isConfigured(), steps: [] };
  if (!out.configured) return out;
  const step = (name, r) => out.steps.push({
    name, status: r.status, ok: r.ok,
    error: r.error ? { code: r.error.code, message: r.error.message, reason: r.error.reason } : undefined,
    rateLimitRemaining: r.headers && r.headers.rateLimitRemaining,
    meter: r.headers && r.headers.rateLimitMetric,
  });
  const actorId = "smoke-test";
  step("health", await commsRequest("/health"));
  const sources = await commsRequest("/sources", { actorId });
  step("sources", sources);
  if (sources.ok && Array.isArray(sources.data)) out.sourceCount = sources.data.length;
  const conv = await commsRequest("/entities/episode/tvdb-900000001-s1e1/conversation", { actorId });
  step("conversation (mock episode)", conv);
  if (conv.ok && conv.data) out.mockConversation = { comments: conv.data.comments, replies: conv.data.replies };
  const list = await commsRequest("/entities/episode/tvdb-900000001-s1e1/comments?limit=5", { actorId });
  step("comments (mock episode)", list);
  if (write) {
    const w = await commsRequest("/entities/episode/tvdb-900000001-s1e1/comments", {
      method: "POST", actorId, idempotencyKey: crypto.randomUUID(),
      body: { text: "smoke test", language: "en", entity: { title: "Pilot", showTitle: "Partner integration test" } },
    });
    step("write comment (mock episode)", w);
  }
  return out;
}

module.exports = { isConfigured, actorIdFor, commsRequest, runSmokeTest };
