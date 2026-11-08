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

// At most this many people get a "new comment" notification per comment, so one
// comment on a very popular title can never write thousands of rows in one request.
const NEW_COMMENT_MAX_RECIPIENTS = 200;

/**
 * Tells people who have already WATCHED this episode that someone commented on it.
 * Only people who have watched it, and the text of the comment is NOT included: a
 * comment can spoil the episode, and the notification title names the episode.
 * Someone with an unread "new comment" notification for the same episode is skipped,
 * so a busy thread shows up as one line, not one per comment. The author is skipped.
 * Top-level comments only (replies already notify the person being replied to).
 * Returns how many notifications were written.
 */
async function notifyEpisodeWatchersOfComment(episodeId, authorId, label) {
  const { rowCount } = await getPool().query(
    `insert into notifications (user_id, type, title, body, data)
     select we.user_id, 'comment_new', 'New comment on an episode you watched', $3::text, $4::jsonb
       from watched_episodes we
      where we.episode_id = $1
        and we.user_id <> $2
        and not exists (
          select 1 from notifications n
           where n.user_id = we.user_id and n.type = 'comment_new' and n.read = false
             and n.data->>'episodeId' = we.episode_id::text
        )
      limit ${NEW_COMMENT_MAX_RECIPIENTS}`,
    [episodeId, authorId, `New comment on ${label}`, JSON.stringify({ episodeId, label })]
  );
  return rowCount || 0;
}

/** Same as above for a movie: people who marked it watched. */
async function notifyMovieWatchersOfComment(tmdbId, authorId, label) {
  const { rowCount } = await getPool().query(
    `insert into notifications (user_id, type, title, body, data)
     select umw.user_id, 'comment_new', 'New comment on a movie you watched', $3::text, $4::jsonb
       from movies m
       join user_movie_watchlist umw on umw.movie_id = m.id and umw.status = 'watched'
      where m.tmdb_id = $1
        and umw.user_id <> $2
        and not exists (
          select 1 from notifications n
           where n.user_id = umw.user_id and n.type = 'comment_new' and n.read = false
             and n.data->>'movieId' = m.tmdb_id::text
        )
      limit ${NEW_COMMENT_MAX_RECIPIENTS}`,
    [Number(tmdbId), authorId, `New comment on ${label}`, JSON.stringify({ movieId: Number(tmdbId), label })]
  );
  return rowCount || 0;
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
 * Marks every one of this user's notifications read. Kept for
 * completeness, but the primary flow (Kostas' call) is per-item now —
 * see markRead below: opening the notifications LIST doesn't clear the
 * badge anymore, only actually tapping/viewing a specific notification
 * does, so someone can see there's activity without it silently
 * vanishing before they've dealt with each one.
 */
async function markAllRead(supabase, userId) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("user_id", userId).eq("read", false);
  if (error) throw error;
  return { ok: true };
}

/**
 * Marks ONE notification read — called when the person taps it (see
 * NotificationsScreen), which both opens whatever it points to
 * (an episode's comments, for a like/reply) and removes it from their
 * unread count. Scoped to userId too, not just the id, so one user
 * can't mark another's notification read via a guessed id.
 */
async function markRead(supabase, userId, notificationId) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("id", notificationId).eq("user_id", userId);
  if (error) throw error;
  return { ok: true };
}

module.exports = { createNotification, notifyEpisodeWatchersOfComment, notifyMovieWatchersOfComment, listNotifications, getUnreadCount, markAllRead, markRead };
