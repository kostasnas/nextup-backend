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

async function reconcileWatchingStatuses(supabase) {
  const { data: rows, error } = await supabase
    .from("user_watchlist")
    .select("user_id, show_id, shows(tmdb_id, title)")
    .eq("status", "watching");
  if (error) throw error;
  if (!rows || rows.length === 0) return { checked: 0, updated: 0 };

  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;

  for (const row of rows) {
    if (!row.shows) continue;

    const { data: airedEpisodes, error: epErr } = await supabase
      .from("episodes")
      .select("id")
      .eq("show_id", row.show_id)
      .lte("air_date", today);
    if (epErr) { console.error(`Episode lookup failed for ${row.shows.title}:`, epErr.message); continue; }

    const airedIds = (airedEpisodes || []).map((e) => e.id);
    if (airedIds.length === 0) continue; // nothing aired yet — leave as watching

    const { count: watchedCount, error: watchedErr } = await supabase
      .from("watched_episodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", row.user_id)
      .in("episode_id", airedIds);
    if (watchedErr) { console.error(`Watched-count lookup failed for ${row.shows.title}:`, watchedErr.message); continue; }

    if (watchedCount < airedIds.length) continue; // genuinely still has something to watch

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

  return { checked: rows.length, updated };
}

module.exports = { reconcileWatchingStatuses };
