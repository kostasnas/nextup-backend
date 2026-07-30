// pushNotifications.js
// Sends "new episode is out" push notifications via Firebase Cloud
// Messaging. Only notifies about episodes that aired TODAY — this is
// deliberate: if we notified about the whole backlog of unwatched
// episodes every day, it would be a daily spam blast instead of a
// genuine "hey, something new is here" alert.

const admin = require("firebase-admin");

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set in environment");

  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
}

/**
 * Finds every (user, episode) pair where:
 *   - the episode aired today
 *   - the user has the show as 'watching' or 'up_to_date'
 *   - the user hasn't already marked it watched
 * then sends one push notification per user (grouped, so someone
 * watching 3 shows that all dropped an episode today gets a single
 * combined notification, not three separate pings).
 */
async function sendDailyUpcomingNotifications(supabase) {
  ensureInitialized();

  const today = new Date().toISOString().slice(0, 10);

  const { data: rows, error } = await supabase
    .from("episodes")
    .select(`
      id, season_number, episode_number, air_date,
      shows!inner(id, title,
        user_watchlist!inner(user_id, status)
      )
    `)
    .eq("air_date", today)
    .in("shows.user_watchlist.status", ["watching", "up_to_date"]);

  if (error) throw error;
  if (!rows || rows.length === 0) return { notifiedUsers: 0, episodesConsidered: 0 };

  // Filter out episodes the user already marked watched (import jobs
  // can occasionally pre-mark same-day episodes), then group by user.
  const episodeIds = rows.map((r) => r.id);
  const { data: alreadyWatched } = await supabase
    .from("watched_episodes")
    .select("user_id, episode_id")
    .in("episode_id", episodeIds);
  const watchedSet = new Set((alreadyWatched || []).map((w) => `${w.user_id}:${w.episode_id}`));

  const byUser = new Map(); // user_id -> [show titles]
  for (const row of rows) {
    for (const wl of row.shows.user_watchlist) {
      if (watchedSet.has(`${wl.user_id}:${row.id}`)) continue;
      if (!byUser.has(wl.user_id)) byUser.set(wl.user_id, new Set());
      byUser.get(wl.user_id).add(row.shows.title);
    }
  }

  if (byUser.size === 0) return { notifiedUsers: 0, episodesConsidered: rows.length };

  const userIds = Array.from(byUser.keys());
  const { data: tokenRows } = await supabase.from("push_tokens").select("user_id, token").in("user_id", userIds);

  const tokensByUser = new Map();
  for (const t of tokenRows || []) {
    if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, []);
    tokensByUser.get(t.user_id).push(t.token);
  }

  let notifiedUsers = 0;
  for (const [userId, titlesSet] of byUser.entries()) {
    const tokens = tokensByUser.get(userId);
    if (!tokens || tokens.length === 0) continue; // no device registered — nothing to send to

    const titles = Array.from(titlesSet);
    const body = titles.length === 1
      ? `A new episode of ${titles[0]} is out.`
      : `New episodes are out for ${titles.length} of your shows.`;

    try {
      await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: "New episode ready to watch", body },
      });
      notifiedUsers++;
    } catch (err) {
      console.error(`Push send failed for user ${userId}:`, err.message);
    }
  }

  return { notifiedUsers, episodesConsidered: rows.length };
}

module.exports = { sendDailyUpcomingNotifications };
