// pushNotifications.js
// Sends "new episode is out" push notifications via Firebase Cloud
// Messaging. Only notifies about episodes that aired TODAY — this is
// deliberate: if we notified about the whole backlog of unwatched
// episodes every day, it would be a daily spam blast instead of a
// genuine "hey, something new is here" alert.

const admin = require("firebase-admin");
const { getShowDetails } = require("./tmdbMatcher");

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set in environment");

  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
}

// Explicit Android notification styling — set directly on every
// message instead of relying solely on the app's AndroidManifest
// default. This is what actually takes priority on the device; the
// manifest default is only a fallback for messages that omit this.
// "ic_stat_name" must match the drawable resource created via
// Android Studio's Image Asset tool (Notification Icons / Image type).
const ANDROID_NOTIFICATION_STYLE = {
  notification: {
    icon: "ic_stat_name",
    color: "#E8A33D",
  },
};

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
        android: ANDROID_NOTIFICATION_STYLE,
      });
      notifiedUsers++;
    } catch (err) {
      console.error(`Push send failed for user ${userId}:`, err.message);
    }
  }

  return { notifiedUsers, episodesConsidered: rows.length };
}

/**
 * Finds shows marked "up_to_date" whose next season premieres within
 * 5 days (per TMDB's own next_episode_to_air field, since our own
 * `episodes` table only knows what we've already synced — it won't
 * know about a season TMDB announced after the person's last import).
 *
 * For each such show: flips every affected user's status from
 * up_to_date -> watching (so it shows up with a countdown in their
 * Watching list, and in Coming Up), caches the newly-known episode
 * into our own `episodes` table, and sends a push notification.
 *
 * The show returns to "up_to_date" automatically once the person
 * marks that episode watched — that part is already handled by the
 * existing finale-detection logic in the app itself, nothing new
 * needed here for the return trip.
 */
async function checkUpcomingPremieres(supabase) {
  ensureInitialized();

  const { data: upToDateRows, error } = await supabase
    .from("user_watchlist")
    .select("user_id, show_id, shows(id, tmdb_id, title, poster_path)")
    .eq("status", "up_to_date");
  if (error) throw error;
  if (!upToDateRows || upToDateRows.length === 0) return { showsChecked: 0, showsPromoted: 0, usersNotified: 0 };

  // Group by show so we only hit TMDB once per show, even if many
  // users have it marked up_to_date.
  const showsMap = new Map();
  for (const row of upToDateRows) {
    if (!row.shows) continue;
    if (!showsMap.has(row.shows.tmdb_id)) showsMap.set(row.shows.tmdb_id, { show: row.shows, userIds: [] });
    showsMap.get(row.shows.tmdb_id).userIds.push(row.user_id);
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let showsPromoted = 0;
  let usersNotified = 0;

  for (const { show, userIds } of showsMap.values()) {
    let details;
    try {
      details = await getShowDetails(show.tmdb_id);
    } catch (err) {
      console.error(`TMDB lookup failed for show ${show.tmdb_id}:`, err.message);
      continue;
    }

    const nextEp = details.next_episode_to_air;
    if (!nextEp || !nextEp.air_date) continue;

    const airDate = new Date(nextEp.air_date + "T00:00:00");
    const daysUntil = Math.round((airDate.getTime() - today.getTime()) / MS_PER_DAY);
    if (daysUntil < 0 || daysUntil > 5) continue; // outside the 5-day window

    // Cache this newly-known episode so Coming Up / the Watching
    // countdown (which read from our own `episodes` table, not TMDB
    // live) can see it too.
    await supabase.from("episodes").upsert(
      {
        show_id: show.id,
        tmdb_episode_id: nextEp.id,
        season_number: nextEp.season_number,
        episode_number: nextEp.episode_number,
        air_date: nextEp.air_date,
        title: nextEp.name || null,
      },
      { onConflict: "show_id,season_number,episode_number" }
    );

    // Only flip users who are STILL up_to_date at this exact moment —
    // avoids clobbering a status they may have changed manually
    // in between the query above and this update.
    await supabase
      .from("user_watchlist")
      .update({ status: "watching", updated_at: new Date().toISOString() })
      .in("user_id", userIds)
      .eq("show_id", show.id)
      .eq("status", "up_to_date");

    showsPromoted++;

    const { data: tokenRows } = await supabase.from("push_tokens").select("user_id, token").in("user_id", userIds);
    const tokensByUser = new Map();
    for (const t of tokenRows || []) {
      if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, []);
      tokensByUser.get(t.user_id).push(t.token);
    }

    const body = daysUntil === 0
      ? `${show.title} premieres today!`
      : `${show.title} premieres in ${daysUntil} day${daysUntil === 1 ? "" : "s"}.`;

    for (const userId of userIds) {
      const tokens = tokensByUser.get(userId);
      if (!tokens || tokens.length === 0) continue;
      try {
        await admin.messaging().sendEachForMulticast({
          tokens,
          notification: { title: "New season coming up", body },
          android: ANDROID_NOTIFICATION_STYLE,
        });
        usersNotified++;
      } catch (err) {
        console.error(`Premiere notification failed for user ${userId}:`, err.message);
      }
    }
  }

  return { showsChecked: showsMap.size, showsPromoted, usersNotified };
}

// Simple daily re-engagement nudge — sent to every registered device
// once a day (via the same cron trigger as everything else). Rotates
// through a few varied messages so it doesn't feel robotic. This is
// deliberately generic (not tied to any specific show), partly to
// keep people in the habit of opening the app, and partly because
// Google's Closed Testing review specifically checks for consistent
// daily engagement across the 14-day period — the single most common
// reason testing tracks get rejected is testers installing once and
// never opening the app again.
const ENGAGEMENT_MESSAGES = [
  { title: "What are you watching tonight?", body: "Check your Watching list and pick up where you left off." },
  { title: "Did you watch anything today?", body: "Mark it off in Scenera so your stats stay accurate." },
  { title: "Your shows are waiting", body: "See what's ready to watch in Scenera." },
];

async function sendDailyEngagementNudge(supabase) {
  ensureInitialized();
  const { data: tokenRows, error } = await supabase.from("push_tokens").select("token");
  if (error) throw error;

  const tokens = [...new Set((tokenRows || []).map((t) => t.token))];
  if (tokens.length === 0) return { devicesTargeted: 0 };

  const message = ENGAGEMENT_MESSAGES[Math.floor(Math.random() * ENGAGEMENT_MESSAGES.length)];

  try {
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      android: ANDROID_NOTIFICATION_STYLE,
    });
    return { devicesTargeted: tokens.length, successCount: result.successCount, failureCount: result.failureCount };
  } catch (err) {
    console.error("Daily engagement nudge failed:", err.message);
    return { devicesTargeted: tokens.length, error: err.message };
  }
}

module.exports = { sendDailyUpcomingNotifications, checkUpcomingPremieres, sendDailyEngagementNudge, ensureInitialized };
