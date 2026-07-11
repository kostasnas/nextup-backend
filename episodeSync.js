// episodeSync.js
// Fetches a show's full episode list from TMDB (once per show, cached),
// then marks the first N episodes as watched based on the TV Time
// episode count — this is how we translate "94 episodes seen" into
// actual per-episode watched_episodes rows without ever having had
// a real per-episode log from TV Time.

const TMDB_BASE = "https://api.themoviedb.org/3";

async function tmdbFetch(path) {
  const apiKey = process.env.TMDB_API_KEY;
  const url = `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB fetch failed (${res.status}): ${path}`);
  return res.json();
}

/**
 * Fetches every episode of a show across all seasons, in air-date order.
 * Skips season 0 (specials) — TV Time's episode counts don't reliably
 * include specials, and mixing them in risks throwing off the "first
 * N episodes" alignment.
 */
async function fetchAllEpisodes(tmdbId) {
  const show = await tmdbFetch(`/tv/${tmdbId}`);
  const seasonNumbers = (show.seasons || [])
    .map((s) => s.season_number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  const episodes = [];
  for (const seasonNumber of seasonNumbers) {
    const season = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`);
    for (const ep of season.episodes || []) {
      episodes.push({
        tmdb_episode_id: ep.id,
        season_number: seasonNumber,
        episode_number: ep.episode_number,
        air_date: ep.air_date || null,
        title: ep.name || null,
      });
    }
    // Small pacing delay between season calls to stay well under TMDB rate limits.
    await new Promise((r) => setTimeout(r, 150));
  }

  // Air-date order when available, falling back to season/episode order
  // for episodes with no air date yet (unaired) or missing data.
  episodes.sort((a, b) => {
    if (a.air_date && b.air_date) return a.air_date.localeCompare(b.air_date);
    if (a.season_number !== b.season_number) return a.season_number - b.season_number;
    return a.episode_number - b.episode_number;
  });

  // "Ended" / "Canceled" mean no more episodes are coming — needed to
  // decide whether "watched everything released so far" means the
  // show is completed, or just that the user is caught up on an
  // ongoing show.
  return { episodes, showStatus: show.status };
}

/**
 * Caches a show's episodes in Supabase (upsert, safe to re-run) and
 * returns the rows with their internal UUIDs, needed to write
 * watched_episodes rows next.
 */
async function cacheEpisodes(supabase, showRowId, episodes) {
  if (episodes.length === 0) return [];

  const rows = episodes.map((ep) => ({ show_id: showRowId, ...ep }));
  const { data, error } = await supabase
    .from("episodes")
    .upsert(rows, { onConflict: "show_id,season_number,episode_number" })
    .select();
  if (error) throw error;

  // Re-sort the returned rows the same way, since upsert doesn't
  // guarantee order back.
  return data.sort((a, b) => {
    if (a.season_number !== b.season_number) return a.season_number - b.season_number;
    return a.episode_number - b.episode_number;
  });
}

/**
 * Marks the first N cached episodes as watched for a user. Uses
 * upsert on (user_id, episode_id) so re-running an import (or syncing
 * twice) never creates duplicates or errors.
 */
async function markProgress(supabase, userId, cachedEpisodes, episodesSeenCount) {
  const toMark = cachedEpisodes.slice(0, episodesSeenCount);
  if (toMark.length === 0) return 0;

  const rows = toMark.map((ep) => ({
    user_id: userId,
    episode_id: ep.id,
    source: "import_tvtime",
  }));

  const { error } = await supabase.from("watched_episodes").upsert(rows, { onConflict: "user_id,episode_id" });
  if (error) throw error;
  return rows.length;
}

/**
 * Full pipeline for one show: fetch from TMDB, cache, mark progress,
 * and flip user_watchlist to 'completed' if the show has ended and
 * the user has watched every episode.
 */
async function syncShowProgress(supabase, { userId, showRowId, tmdbId, episodesSeenCount }) {
  const { episodes, showStatus } = await fetchAllEpisodes(tmdbId);
  const cached = await cacheEpisodes(supabase, showRowId, episodes);
  const markedCount = await markProgress(supabase, userId, cached, episodesSeenCount);

  const showHasEnded = showStatus === "Ended" || showStatus === "Canceled";
  const watchedEverything = cached.length > 0 && episodesSeenCount >= cached.length;

  if (showHasEnded && watchedEverything) {
    await supabase
      .from("user_watchlist")
      .update({ status: "completed" })
      .eq("user_id", userId)
      .eq("show_id", showRowId)
      .neq("status", "dropped"); // don't resurrect a show the user explicitly dropped
  }

  return { totalEpisodes: cached.length, markedCount, showStatus };
}

module.exports = { fetchAllEpisodes, cacheEpisodes, markProgress, syncShowProgress };
