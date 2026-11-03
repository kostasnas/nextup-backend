// statusReconciliation.js
// Finds every (user, show) pair marked "watching" where every aired
// episode is already watched, and corrects the status to what it
// should actually be:
//   - 'completed' if TMDB says the series has ended/been canceled
//   - 'up_to_date' if the series is still ongoing (Returning Series)
//
// This exists because status transitions were previously only
// triggered by a specific live user action (checking off the very
// last known episode in Show Detail) — shows that reached "fully
// caught up" through any other path (import, catching up across
// multiple sessions) could get stuck showing as "watching" forever,
// with nothing actually left to watch. Running this periodically
// (via the daily cron) keeps everyone's statuses honest going forward.

const { getShowDetails } = require("./tmdbMatcher");
const { getPool } = require("./db");

async function reconcileWatchingStatuses(supabase) {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10);

  const { rows: [{ total }] } = await pool.query(
    `select count(*)::int as total from user_watchlist where status = 'watching'`
  );
  if (!total) return { checked: 0, updated: 0 };

  // One SQL query finds every (user, show) that is "watching" but has every
  // aired episode already watched. The old version fetched each show's
  // episode ids and sent them back in a huge .in(...) list through the REST
  // API, which failed ("fetch failed") for long shows (Grey's Anatomy, Law &
  // Order, The Simpsons, Naruto...) so those were never reconciled.
  const { rows } = await pool.query(
    `select w.user_id, w.show_id, s.tmdb_id, s.title
       from user_watchlist w
       join shows s on s.id = w.show_id
      where w.status = 'watching'
        and exists (select 1 from episodes e where e.show_id = w.show_id and e.air_date <= $1)
        and not exists (
          select 1 from episodes e
           where e.show_id = w.show_id and e.air_date <= $1
             and not exists (select 1 from watched_episodes we where we.user_id = w.user_id and we.episode_id = e.id)
        )`,
    [today]
  );

  let updated = 0;

  for (const r of rows) {
    const row = { user_id: r.user_id, show_id: r.show_id, shows: { tmdb_id: r.tmdb_id, title: r.title } };

    // Fully caught up — figure out where it belongs by asking TMDB
    // whether the series itself has actually ended.
    try {
      const details = await getShowDetails(row.shows.tmdb_id);
      const hasEnded = details.status === "Ended" || details.status === "Canceled";
      const newStatus = hasEnded ? "completed" : "up_to_date";

      await supabase
        .from("user_watchlist")
        .update({ status: newStatus })
        .eq("user_id", row.user_id)
        .eq("show_id", row.show_id);
      updated++;
    } catch (err) {
      console.error(`TMDB lookup failed for ${row.shows.title}:`, err.message);
    }
  }

  return { checked: total, updated };
}

module.exports = { reconcileWatchingStatuses };
