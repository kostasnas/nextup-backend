// welcomeMessages.js
// One-off "welcome to Scenera" push notification (device push only,
// not email or the in-app inbox) for everyone who signed up in the
// last N days. Not automatic/scheduled — triggered manually via POST
// /admin/send-welcome (see server.js), same shared-secret pattern as
// the other /admin endpoints.

const admin = require("firebase-admin");
const { ensureInitialized } = require("./pushNotifications");
const { getUsersCreatedSince } = require("./db");

const MAX_TOKENS_PER_BATCH = 500; // same FCM limit broadcastNotification.js works around

const TITLE = "Welcome to Scenera 👋";
const BODY = "We hope you enjoy tracking your shows and movies. Let us know if anything's missing!";

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// days: how far back to look for new signups (Kostas asked for the
// last 3 days on the first run).
async function sendWelcomeMessages(supabase, { days = 3 } = {}) {
  ensureInitialized();
  const users = await getUsersCreatedSince(days);
  if (users.length === 0) return { usersFound: 0, devicesTargeted: 0, successCount: 0, failureCount: 0 };

  const userIds = users.map((u) => u.id);
  const { data: tokenRows, error } = await supabase
    .from("push_tokens")
    .select("token")
    .in("user_id", userIds);
  if (error) throw error;

  const tokens = [...new Set((tokenRows || []).map((t) => t.token))]; // de-dupe, same device can re-register
  if (tokens.length === 0) return { usersFound: users.length, devicesTargeted: 0, successCount: 0, failureCount: 0 };

  const batches = chunk(tokens, MAX_TOKENS_PER_BATCH);
  let successCount = 0;
  let failureCount = 0;

  for (const batch of batches) {
    try {
      const result = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: { title: TITLE, body: BODY },
        android: { notification: { icon: "ic_stat_name", color: "#E8A33D" } },
      });
      successCount += result.successCount;
      failureCount += result.failureCount;
    } catch (err) {
      console.error("Welcome push batch failed:", err.message);
      failureCount += batch.length;
    }
  }

  return { usersFound: users.length, devicesTargeted: tokens.length, successCount, failureCount };
}

module.exports = { sendWelcomeMessages };
