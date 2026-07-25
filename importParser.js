// importParser.js — v3
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
  const episodeLogByShow = files["seen_episode_source.csv"]
    ? parseEpisodeLog(files["seen_episode_source.csv"])
    : {};
  const emotionLogByShow = files["episode_emotion.csv"]
    ? parseEmotionLog(files["episode_emotion.csv"])
    : {};

  return {
    shows: results,
    episodeLogByShow,
    emotionLogByShow,
    stats: {
      totalShows: results.length,
      followedShows: results.filter((s) => s.isFollowed).length,
      ratedShows: results.filter((s) => s.rating !== null).length,
      withEpisodeData,
      hasEpisodeLog: Object.keys(episodeLogByShow).length > 0,
      hasEmotionLog: Object.keys(emotionLogByShow).length > 0,
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
