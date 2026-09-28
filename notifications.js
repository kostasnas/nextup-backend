// notifications.js
// In-app notification inbox — currently used for comment likes and
// replies only (see server.js). Deliberately kept separate from push
// (pushNotifications.js): a like or reply on a busy comment thread
// firing an immediate phone push per event read as spammy (Kostas'
// call: these two event types should surface only when the person
// opens the app, not as a phone push), so createNotification below
// writes a row here instead of calling sendPushToUser.
const { getPool } = require("./db");

async function createNotification(supabase, userId, { type, title, body, data }) {
  const { error } = await supabase.from("notifications").insert({
    user_id: userId,
    type,
    title,
    body,
    data: data || null,
  });
  if (error) throw error;
}

/**
 * Most recent notifications for one user, newest first. Capped at 50
 * — this is a recent-activity inbox, not a full archive.
 */
async function listNotifications(userId) {
  const { rows } = await getPool().query(
    `select id, type, title, body, data, read, created_at
     from notifications
     where user_id = $1
     order by created_at desc
     limit 50`,
    [userId]
  );
  return rows;
}

async function getUnreadCount(userId) {
  const { rows } = await getPool().query(
    `select count(*)::int as count from notifications where user_id = $1 and read = false`,
    [userId]
  );
  return rows[0]?.count || 0;
}

/**
 * Marks every one of this user's notifications read — called when
 * they open the notifications list, not per-item, since the point is
 * "you've now seen your activity", matching how the badge count works.
 */
async function markAllRead(supabase, userId) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("user_id", userId).eq("read", false);
  if (error) throw error;
  return { ok: true };
}

module.exports = { createNotification, listNotifications, getUnreadCount, markAllRead };
