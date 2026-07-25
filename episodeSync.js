// episodeSync.js
// Fetches a show's full episode list from TMDB (once per show, cached),
// then marks episodes as watched using the best data available:
//   1. Exact per-episode log (real dates), when the export included it
//   2. Count-based fallback ("first N episodes"), for everything else
// Also applies personal episode reactions from the emotion log, and
// decides whether a caught-up show is 'completed' (TMDB says ended)
// or 'up_to_date' (still ongoing, more episodes expected).

const TMDB_BASE = "https://api.themoviedb.org/3";

async function tmdbFetch(path) {
  const apiKey = process.env.TMDB_API_KEY;
  const url = `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB fetch failed (${res.status}): ${path}`);
  return res.json();
}

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
    await new Promise((r) => setTimeout(r, 150));
  }

  episodes.sort((a, b) => {
    if (a.air_date && b.air_date) return a.air_date.localeCompare(b.air_date);
    if (a.season_number !== b.season_number) return a.season_number - b.season_number;
    return a.episode_number - b.episode_number;
  });

  return { episodes, showStatus: show.status };
}

async function cacheEpisodes(supabase, showRowId, episodes) {
  if (episodes.length === 0) return [];

  const rows = episodes.map((ep) => ({ show_id: showRowId, ...ep }));
  const { data, error } = await supabase
    .from("episodes")
    .upsert(rows, { onConflict: "show_id,season_number,episode_number" })
    .select();
  if (error) throw error;

  return data.sort((a, b) => {
    if (a.season_number !== b.season_number) return a.season_number - b.season_number;
    return a.episode_number - b.episode_number;
  });
}

/**
 * Marks specific episodes as watched using real dates from the
 * export's per-episode log. Never overwrites an existing row
 * (ignoreDuplicates) — if it's already marked watched (from a
 * previous run, or about to be top-filled below), we leave it alone.
 */
async function applyEpisodeLog(supabase, userId, cachedEpisodes, episodeLog) {
  if (!episodeLog || episodeLog.length === 0) return 0;

  const byKey = {};
  cachedEpisodes.forEach((ep) => { byKey[`${ep.season_number}-${ep.episode_number}`] = ep; });

  const rows = [];
  for (const entry of episodeLog) {
    const ep = byKey[`${entry.season}-${entry.episode}`];
    if (!ep) continue;
    rows.push({
      user_id: userId,
      episode_id: ep.id,
      watched_at: entry.watchedAt || new Date().toISOString(),
      source: "import_tvtime_log",
    });
  }
  if (rows.length === 0) return 0;

  const { error } = await supabase
    .from("watched_episodes")
    .upsert(rows, { onConflict: "user_id,episode_id", ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

/**
 * Applies the user's personal reaction to specific episodes (only
 * where we have a confident mapping — see importParser.js). Only
 * touches rows that already exist (episode must be marked watched).
 */
async function applyEmotionLog(supabase, userId, cachedEpisodes, emotionLog) {
  if (!emotionLog || emotionLog.length === 0) return;

  const byKey = {};
  cachedEpisodes.forEach((ep) => { byKey[`${ep.season_number}-${ep.episode_number}`] = ep; });

  for (const entry of emotionLog) {
    if (!entry.reaction) continue;
    const ep = byKey[`${entry.season}-${entry.episode}`];
    if (!ep) continue;
    await supabase.from("watched_episodes").update({ reaction: entry.reaction }).eq("user_id", userId).eq("episode_id", ep.id);
  }
}

/**
 * Fills in the first N cached episodes as watched (existing
 * count-based approach), skipping any that are already marked —
 * never overwrites a real date with "now".
 */
async function markProgress(supabase, userId, cachedEpisodes, episodesSeenCount) {
  const toMark = cachedEpisodes.slice(0, episodesSeenCount);
  if (toMark.length === 0) return 0;

  const rows = toMark.map((ep) => ({
    user_id: userId,
    episode_id: ep.id,
    source: "import_tvtime",
  }));

  const { error } = await supabase
    .from("watched_episodes")
    .upsert(rows, { onConflict: "user_id,episode_id", ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

/**
 * Full pipeline for one show: fetch from TMDB, cache, mark progress
 * (exact log first, count-based fallback second), apply reactions,
 * and set the right watchlist status (completed vs up_to_date vs
 * left as watching).
 */
async function syncShowProgress(supabase, { userId, showRowId, tmdbId, episodesSeenCount, episodeLog, emotionLog }) {
  const { episodes, showStatus } = await fetchAllEpisodes(tmdbId);
  const cached = await cacheEpisodes(supabase, showRowId, episodes);

  await applyEpisodeLog(supabase, userId, cached, episodeLog);
  const markedCount = await markProgress(supabase, userId, cached, episodesSeenCount);
  await applyEmotionLog(supabase, userId, cached, emotionLog);

  const showHasEnded = showStatus === "Ended" || showStatus === "Canceled";
  const watchedEverything = cached.length > 0 && episodesSeenCount >= cached.length;

  if (watchedEverything) {
    const newStatus = showHasEnded ? "completed" : "up_to_date";
    await supabase
      .from("user_watchlist")
      .update({ status: newStatus })
      .eq("user_id", userId)
      .eq("show_id", showRowId)
      .neq("status", "dropped"); // don't resurrect a show the user explicitly dropped
  }

  return { totalEpisodes: cached.length, markedCount, showStatus };
}

module.exports = { fetchAllEpisodes, cacheEpisodes, markProgress, syncShowProgress };
