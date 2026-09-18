// importParser.js — v4
// Adds OPTIONAL movie support, alongside the existing show-progress
// import. IMPORTANT CAVEAT: TV Time did support movie tracking
// (confirmed via its own store listings — "TV Time: Track Shows &
// Movies"), but we don't have a real sample export containing
// movie data to verify the exact file name/column structure against
// (Kostas's own account never tracked movies). This is a best-effort
// guess, following the SAME naming conventions already confirmed in
// TV Time's own show-related files (tv_show_name, created_at style —
// not Bingers' different convention of title/tmdb_id, which is a
// different app). Checks a few plausible file name variants
// defensively, matching the pattern already used above for
// tracking-prod-records-v2.csv vs seen_episode_source.csv. If this
// doesn't match a real user's actual export, it fails harmlessly
// (movies array stays empty) rather than throwing — safe to ship,
// but worth revisiting once someone with real movie history reports
// it not working.
//
// Extends the show-progress import (v2) with two OPTIONAL extra
// files, present in the fuller "download all my data" GDPR export
// but not in the minimal 4-file one:
//   - seen_episode_source.csv   real per-episode watch events with
//                                actual dates (source, created_at,
//                                tv_show_name, season, episode)
//   - episode_emotion.csv       the user's personal per-episode
//                                reaction (emotion_id)
//
// These are grouped by tv_show_name (matching the same field used in
// user_tv_show_data.csv) so the matching step can look them up per
// show without needing a second matching pass.
//
// Coverage caveat: these files are typically NOT exhaustive — the
// account inspected had only ~1700 logged episode events across a
// history of tens of thousands. Treat them as "ground truth where
// present" and keep the existing show-progress (count-based) fallback
// for everything else.

const Papa = require("papaparse");

function parseCsvFile(fileContent) {
  const { data } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
  return data;
}

function parseGdprExport(files) {
  const showData = parseCsvFile(files["user_tv_show_data.csv"] || "");
  const latestEpisode = parseCsvFile(files["show_seen_episode_latest.csv"] || "");
  const followed = parseCsvFile(files["followed_tv_show.csv"] || "");
  const ratings = parseCsvFile(files["tv_show_rate.csv"] || "");

  const latestByShow = indexBy(latestEpisode, "tv_show_id");
  const followedByShow = indexBy(followed, "tv_show_id");
  const ratingByShow = indexBy(ratings, "tv_show_id");

  const results = showData
    .filter((row) => row.tv_show_id && row.tv_show_name)
    .map((row) => {
      const showId = row.tv_show_id;
      const latest = latestByShow[showId];
      const follow = followedByShow[showId];
      const rating = ratingByShow[showId];

      return {
        tvTimeShowId: parseIntOrNull(showId),
        title: row.tv_show_name.trim(),
        episodesSeenCount: parseIntOrNull(row.nb_episodes_seen) || 0,
        isFavorited: row.is_favorited === "1",
        isFollowed: row.is_followed === "1" || follow?.active === "1",
        isArchived: follow?.archived === "1" || false,
        rating: rating ? parseIntOrNull(rating.rating) : null,
        latestEpisodeIdRaw: latest?.episode_id || null,
        latestWatchedAt: parseDateOrNull(latest?.updated_at),
      };
    });

  const withEpisodeData = results.filter((s) => s.episodesSeenCount > 0).length;
  const suspiciouslyEmpty = results.length > 0 && withEpisodeData / results.length < 0.1;

  // Optional richer files — present only in the fuller export.
  // tracking-prod-records-v2.csv has ~4x the coverage of seen_episode_source.csv
  // in real accounts (7000+ vs ~1700 real watch events) — prefer it when present.
  const episodeLogByShow = files["tracking-prod-records-v2.csv"]
    ? parseTrackingRecordsV2(files["tracking-prod-records-v2.csv"])
    : files["seen_episode_source.csv"]
    ? parseEpisodeLog(files["seen_episode_source.csv"])
    : {};
  const emotionLogByShow = files["episode_emotion.csv"]
    ? parseEmotionLog(files["episode_emotion.csv"])
    : {};

  const movies = parseMovieLog(files);

  return {
    shows: results,
    movies,
    episodeLogByShow,
    emotionLogByShow,
    stats: {
      totalShows: results.length,
      followedShows: results.filter((s) => s.isFollowed).length,
      ratedShows: results.filter((s) => s.rating !== null).length,
      withEpisodeData,
      hasEpisodeLog: Object.keys(episodeLogByShow).length > 0,
      hasEmotionLog: Object.keys(emotionLogByShow).length > 0,
      totalMovies: movies.length,
      warning: suspiciouslyEmpty
        ? "Fewer than 10% of shows have episode counts — double-check that user_tv_show_data.csv was uploaded to the right field, it's the source of nb_episodes_seen."
        : null,
    },
  };
}

/**
 * Groups real per-episode watch events by show title.
 * @returns {Object.<string, Array<{season:number, episode:number, watchedAt:string|null}>>}
 */
/**
 * Groups real per-episode watch events from the richer tracking export
 * by show title. Filters to just "watch-episode" entries (the file
 * also has "user-series" and "rewatch-episode" rows we don't need here).
 * @returns {Object.<string, Array<{season:number, episode:number, watchedAt:string|null}>>}
 */
function parseTrackingRecordsV2(fileContent) {
  const rows = parseCsvFile(fileContent);
  const byShow = {};
  for (const row of rows) {
    if (!row.key || !row.key.startsWith("watch-episode")) continue;
    const name = row.series_name?.trim();
    const season = parseIntOrNull(row.season_number);
    const episode = parseIntOrNull(row.episode_number);
    if (!name || season === null || episode === null) continue;
    if (!byShow[name]) byShow[name] = [];
    byShow[name].push({ season, episode, watchedAt: parseDateOrNull(row.created_at) });
  }
  return byShow;
}

function parseEpisodeLog(fileContent) {
  const rows = parseCsvFile(fileContent);
  const byShow = {};
  for (const row of rows) {
    const name = row.tv_show_name?.trim();
    const season = parseIntOrNull(row.episode_season_number);
    const episode = parseIntOrNull(row.episode_number);
    if (!name || season === null || episode === null) continue;
    if (!byShow[name]) byShow[name] = [];
    byShow[name].push({ season, episode, watchedAt: parseDateOrNull(row.created_at) });
  }
  return byShow;
}

/**
 * Groups the user's personal episode reactions by show title.
 * Only emotion_id === 1 has a confident mapping (it's overwhelmingly
 * the most common value in sample data, consistent with a "liked"
 * default reaction) — other values aren't publicly documented, so we
 * don't guess a reaction for those rather than risk mislabeling.
 * @returns {Object.<string, Array<{season:number, episode:number, reaction:string|null}>>}
 */
function parseEmotionLog(fileContent) {
  const rows = parseCsvFile(fileContent);
  const byShow = {};
  for (const row of rows) {
    const name = row.tv_show_name?.trim();
    const season = parseIntOrNull(row.episode_season_number);
    const episode = parseIntOrNull(row.episode_number);
    if (!name || season === null || episode === null) continue;
    const emotionId = parseIntOrNull(row.emotion_id);
    if (!byShow[name]) byShow[name] = [];
    byShow[name].push({ season, episode, reaction: emotionId === 1 ? "up" : null });
  }
  return byShow;
}

/**
 * Best-effort movie import — see the file-level caveat above. Checks
 * a few plausible file names/column names (following TV Time's own
 * show-file naming style), returns an empty array harmlessly if none
 * match rather than throwing.
 * @returns {Array<{title:string, watchedAt:string|null, isFavorited:boolean}>}
 */
function parseMovieLog(files) {
  const candidateFileNames = ["seen_movie.csv", "seen_movie_source.csv", "movie_seen.csv", "user_movie_data.csv"];
  const fileName = candidateFileNames.find((name) => files[name]);
  if (!fileName) return [];

  const rows = parseCsvFile(files[fileName]);
  const results = [];
  for (const row of rows) {
    // Checking several plausible column names, since this is a best
    // guess at TV Time's own naming for a file we haven't seen a
    // real sample of — same defensive spirit as the file-name check
    // above.
    const title = (row.movie_name || row.title || row.name || "").trim();
    if (!title) continue;
    results.push({
      title,
      watchedAt: parseDateOrNull(row.created_at || row.watched_at),
      isFavorited: row.is_favorited === "1",
    });
  }
  return results;
}

function indexBy(rows, key) {
  const map = {};
  for (const row of rows) {
    if (row[key]) map[row[key]] = row;
  }
  return map;
}

function parseIntOrNull(val) {
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

function parseDateOrNull(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { parseGdprExport, parseCsvFile };
