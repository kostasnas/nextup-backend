// importParser.js — v2
// Built against a real TV Time GDPR export (July 2026). Confirmed
// against actual file contents, not forum guesses.
//
// KEY FINDING: TV Time's export does NOT contain a clean per-episode
// watch log (episode + exact date for every episode ever watched).
// What it DOES contain, reliably:
//   - user_tv_show_data.csv        show + total episodes seen (count)
//   - show_seen_episode_latest.csv show + latest episode watched
//   - followed_tv_show.csv         show + followed/favorited/active flags
//   - tv_show_rate.csv             show-level rating (1-5)
//
// Strategy: import PROGRESS per show (not a full episode log). Once
// a show is matched to TMDB, we mark all episodes up to
// "latest season/episode" as watched, in air-date order. This is a
// reasonable assumption for sequential viewers and is what a
// comparable tool (Simkl) appears to do successfully with the same
// export — a real user confirmed a clean import.
//
// If TV Time's export ever adds a true per-episode log, this parser
// should be extended rather than replaced — the show-level path
// remains useful as a fallback.

const Papa = require("papaparse");

function parseCsvFile(fileContent) {
  const { data } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
  return data;
}

/**
 * Combines the four source files into one record per show.
 * @param {Object} files - raw file contents keyed by filename
 * @returns {ShowProgress[]}
 */
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
        rating: rating ? parseIntOrNull(rating.rating) : null, // 1-5 scale
        // Latest episode watched — used as the "watched up to here" marker.
        // Note: episode_id here is TV Time's internal ID, not season/episode
        // numbers directly, so this needs a lookup against TV Time's show
        // data OR we fall back to episodesSeenCount + TMDB episode order.
        latestEpisodeIdRaw: latest?.episode_id || null,
        latestWatchedAt: parseDateOrNull(latest?.updated_at),
      };
    });

  const withEpisodeData = results.filter((s) => s.episodesSeenCount > 0).length;
  const suspiciouslyEmpty = results.length > 0 && withEpisodeData / results.length < 0.1;

  return {
    shows: results,
    stats: {
      totalShows: results.length,
      followedShows: results.filter((s) => s.isFollowed).length,
      ratedShows: results.filter((s) => s.rating !== null).length,
      withEpisodeData,
      warning: suspiciouslyEmpty
        ? "Fewer than 10% of shows have episode counts — double-check that user_tv_show_data.csv was uploaded to the right field, it's the source of nb_episodes_seen."
        : null,
    },
  };
}

/**
 * Next stage (not yet implemented here): for each parsed show,
 * fuzzy-match `title` against TMDB's /search/tv, then mark the
 * first N episodes (in air-date order, across seasons) as watched,
 * where N = episodesSeenCount. This sidesteps needing TV Time's
 * internal season/episode numbering entirely.
 */

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
