// traktAuth.js
// OAuth connection flow for live Trakt scrobble sync — separate from
// traktParser.js, which only handles a one-time export file upload.
// This is the "Auto-Tracking (Scrobbling)" backlog item: Stremio
// scrobbles to Trakt natively (it has no way to talk to third-party
// apps directly), so our path to "Stremio auto-marks episodes watched
// in Scenera" is Stremio -> Trakt -> us, polling Trakt's own watch
// history for whatever's new since last sync (see traktSync.js).
//
// OAuth2 Authorization Code flow WITH PKCE (https://trakt.docs.apiary.io
// / developer.trakt.tv) — Trakt now requires PKCE for new apps and
// doesn't even issue a Client Secret for them (confirmed when Kostas
// created the Scenera app: "Not issued. This app signs users in with
// PKCE, so there is no secret to keep safe."), so there's no secret
// to store or leak here — just a Client ID, plus a per-attempt
// code_verifier/code_challenge pair (RFC 7636).
//
// The other tricky part for a mobile+web app with no deep-linking set
// up yet: the callback is a plain unauthenticated browser redirect, so
// it can't carry our own Bearer token. Solved with a short-lived
// `state` row that maps a random token back to the Scenera user who
// started the flow (created while they ARE authenticated, in
// createConnectUrl below) — same idea as a CSRF state param, just also
// used as the user lookup. The code_verifier rides along in the same
// row since it's needed again at token-exchange time.
const crypto = require("crypto");

const TRAKT_BASE = "https://api.trakt.tv";

function getRedirectUri() {
  const base = process.env.BACKEND_PUBLIC_URL || "https://nextup-backend-ccq7.onrender.com";
  return `${base}/trakt/callback`;
}

// Defensive trim — a copy-pasted env var value picking up a stray
// trailing newline/space (easy to do from a phone's clipboard) would
// otherwise silently produce an invalid client_id Trakt rejects.
function getClientId() {
  return (process.env.TRAKT_CLIENT_ID || "").trim();
}

async function createConnectUrl(supabase, userId) {
  const state = crypto.randomBytes(24).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const { error } = await supabase.from("trakt_oauth_states").insert({ state, user_id: userId, code_verifier: codeVerifier });
  if (error) throw error;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  // PKCE apps authorize on auth.trakt.tv, NOT trakt.tv — confirmed via
  // Trakt's own PKCE docs (step 3) after trakt.tv/oauth/authorize kept
  // redirecting to a broken /api/auth error page that dropped our
  // query params ("client_id is required" even with a verified-correct
  // client_id and code_challenge).
  return `https://auth.trakt.tv/oauth/authorize?${params}`;
}

async function handleCallback(supabase, code, state) {
  const { data: stateRow, error: stateErr } = await supabase
    .from("trakt_oauth_states")
    .select("user_id, code_verifier")
    .eq("state", state)
    .maybeSingle();
  if (stateErr) throw stateErr;
  if (!stateRow) throw new Error("This connection link has expired — please try connecting again from Scenera.");

  const res = await fetch(`${TRAKT_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: stateRow.code_verifier,
    }),
  });
  if (!res.ok) throw new Error(`Trakt token exchange failed (${res.status})`);
  const tokens = await res.json();

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const { error: upsertErr } = await supabase.from("trakt_connections").upsert({
    user_id: stateRow.user_id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
  });
  if (upsertErr) throw upsertErr;

  // One-time use — delete it regardless of outcome above succeeding,
  // same spirit as the rest of this flow being as short-lived as
  // possible.
  await supabase.from("trakt_oauth_states").delete().eq("state", state);
  return { ok: true };
}

// Trakt access tokens expire (typically ~3 months) — refreshed here
// using the stored refresh_token, called by traktSync.js right
// before a sync run if the stored token is expired or close to it.
// Never called mid-user-request; always from the background sync job.
async function refreshTokenIfNeeded(supabase, connection) {
  const expiresSoon = new Date(connection.expires_at).getTime() - Date.now() < 60 * 60 * 1000; // 1h buffer
  if (!expiresSoon) return connection;

  const res = await fetch(`${TRAKT_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: connection.refresh_token,
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Trakt token refresh failed (${res.status})`);
  const tokens = await res.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const updated = { ...connection, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt };
  const { error } = await supabase.from("trakt_connections").update({
    access_token: updated.access_token,
    refresh_token: updated.refresh_token,
    expires_at: updated.expires_at,
  }).eq("user_id", connection.user_id);
  if (error) throw error;
  return updated;
}

async function disconnectTrakt(supabase, userId) {
  const { error } = await supabase.from("trakt_connections").delete().eq("user_id", userId);
  if (error) throw error;
  return { ok: true };
}

async function getTraktStatus(supabase, userId) {
  const { data, error } = await supabase
    .from("trakt_connections")
    .select("connected_at, last_synced_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return { connected: !!data, connectedAt: data?.connected_at || null, lastSyncedAt: data?.last_synced_at || null };
}

module.exports = { createConnectUrl, handleCallback, refreshTokenIfNeeded, disconnectTrakt, getTraktStatus, getClientId };
