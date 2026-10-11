// broadcastNotification.js
// Sends one custom push notification to every device that's ever
// registered — used for things like "new version available", not
// tied to any specific show/episode logic. Reusable any time you
// want to reach all testers/users at once (e.g. future announcements),
// not just for this one update.

const admin = require("firebase-admin");
const { ensureInitialized, pruneDeadTokens } = require("./pushNotifications");

// FCM's sendEachForMulticast accepts at most 500 tokens per call —
// chunk defensively in case the user base ever grows past that.
const MAX_TOKENS_PER_BATCH = 500;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function sendBroadcastNotification(supabase, { title, body, test_user_id, user_ids, data }) {
  ensureInitialized();

  if (!title || !body) {
    const err = new Error("title and body are both required");
    err.status = 400;
    throw err;
  }

  // test_user_id restricts the send to a single person's devices —
  // use this to preview a broadcast before firing it at every tester.
  let query = supabase.from("push_tokens").select("token");
  if (test_user_id) query = query.eq("user_id", test_user_id);
  // user_ids sends to a small chosen group in one call (e.g. a feedback request to 3 people).
  // An empty list must not fall through to "everyone".
  if (user_ids !== undefined) {
    if (!Array.isArray(user_ids) || user_ids.length === 0 || user_ids.length > 200 || user_ids.some((u) => typeof u !== "string")) {
      const err = new Error("user_ids must be a non-empty array of up to 200 user id strings");
      err.status = 400;
      throw err;
    }
    query = query.in("user_id", user_ids);
  }
  const { data: tokenRows, error } = await query;
  if (error) throw error;

  const tokens = [...new Set((tokenRows || []).map((t) => t.token))]; // de-dupe, same device can re-register
  if (tokens.length === 0) return { devicesTargeted: 0, batches: 0 };

  const batches = chunk(tokens, MAX_TOKENS_PER_BATCH);
  let successCount = 0;
  let failureCount = 0;
  const errorCodes = {}; // why sends failed, e.g. messaging/registration-token-not-registered

  for (const batch of batches) {
    try {
      const result = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        // FCM data payload values must all be strings — stringify
        // anything that isn't already, so a caller can pass e.g.
        // { type: "open_url", url: "market://..." } directly.
        ...(data ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) } : {}),
        android: { notification: { icon: "ic_stat_name", color: "#E8A33D" } },
      });
      successCount += result.successCount;
      failureCount += result.failureCount;
      await pruneDeadTokens(supabase, batch, result);
      for (const r of result.responses || []) {
        if (!r.success) {
          const code = r.error?.code || "unknown";
          errorCodes[code] = (errorCodes[code] || 0) + 1;
        }
      }
    } catch (err) {
      console.error("Broadcast batch failed:", err.message);
      failureCount += batch.length;
      errorCodes[err.code || "batch_error"] = (errorCodes[err.code || "batch_error"] || 0) + batch.length;
    }
  }

  if (failureCount) console.error("Broadcast failures by reason:", JSON.stringify(errorCodes));
  return { devicesTargeted: tokens.length, batches: batches.length, successCount, failureCount, ...(failureCount ? { errorCodes } : {}) };
}


// How many people still have the app? Validates every stored push token with an FCM dry run
// (nothing is delivered). Uninstalled apps report "not registered" and are pruned as a side
// effect. Undercounts people who never allowed notifications (they have no token at all).
async function checkTokenHealth(supabase) {
  ensureInitialized();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("push_tokens").select("user_id, token").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byToken = new Map(); // token -> user_id
  for (const r of rows) byToken.set(r.token, r.user_id);
  const tokens = [...byToken.keys()];
  const validUsers = new Set();
  const allUsers = new Set(rows.map((r) => r.user_id));
  let valid = 0;
  let dead = 0;
  let other = 0;
  for (const batch of chunk(tokens, MAX_TOKENS_PER_BATCH)) {
    const result = await admin.messaging().sendEachForMulticast({ tokens: batch, notification: { title: "check", body: "check" } }, true);
    result.responses.forEach((r, i) => {
      if (r.success) { valid++; validUsers.add(byToken.get(batch[i])); }
      else if (r.error?.code === "messaging/registration-token-not-registered") dead++;
      else other++;
    });
    await pruneDeadTokens(supabase, batch, result);
  }
  return { tokensChecked: tokens.length, usersWithAnyToken: allUsers.size, validTokens: valid, usersWithValidToken: validUsers.size, deadTokensRemoved: dead, otherErrors: other };
}

module.exports = { sendBroadcastNotification, checkTokenHealth };
