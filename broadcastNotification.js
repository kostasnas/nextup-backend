// broadcastNotification.js
// Sends one custom push notification to every device that's ever
// registered — used for things like "new version available", not
// tied to any specific show/episode logic. Reusable any time you
// want to reach all testers/users at once (e.g. future announcements),
// not just for this one update.

const admin = require("firebase-admin");
const { ensureInitialized } = require("./pushNotifications");

// FCM's sendEachForMulticast accepts at most 500 tokens per call —
// chunk defensively in case the user base ever grows past that.
const MAX_TOKENS_PER_BATCH = 500;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function sendBroadcastNotification(supabase, { title, body, test_user_id }) {
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
  const { data: tokenRows, error } = await query;
  if (error) throw error;

  const tokens = [...new Set((tokenRows || []).map((t) => t.token))]; // de-dupe, same device can re-register
  if (tokens.length === 0) return { devicesTargeted: 0, batches: 0 };

  const batches = chunk(tokens, MAX_TOKENS_PER_BATCH);
  let successCount = 0;
  let failureCount = 0;

  for (const batch of batches) {
    try {
      const result = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        android: { notification: { icon: "ic_stat_name", color: "#E8A33D" } },
      });
      successCount += result.successCount;
      failureCount += result.failureCount;
    } catch (err) {
      console.error("Broadcast batch failed:", err.message);
      failureCount += batch.length;
    }
  }

  return { devicesTargeted: tokens.length, batches: batches.length, successCount, failureCount };
}

module.exports = { sendBroadcastNotification };
