// bingersParser.js
// Parses a Bingers.app data export (library.csv, watches.csv, and
// optionally ratings.csv/lists.csv) into the same {shows, movies,
// stats} shape importParser.js produces for TV Time — so the same
// upsertShowProgress/syncShowProgress pipeline in server.js can
// handle both sources.
//
// Unlike TV Time, Bingers' export already includes a tmdb_id column
// on every row — for shows, episodes AND movies. That removes the
// single biggest source of risk in the TV Time importer entirely:
// there is no fuzzy title matching step here, no confidence
// threshold, no manual-review queue. Every row is already a
// confident, exact TMDB match.
//
// Built and verified against a real export (4 files, ~40 rows) from
// Kostas's own Bingers test account — not a guess at the format like
// importParser.js's movie-support caveat.

const Papa = require("papaparse");

function parseCsvFile(fileContent) {
  const { data } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
  return data;
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

/**
 * watches.csv has one row per episode watch event (type=episode) or
 * movie watch event (type=movie), keyed by real tmdb_id — no title
 * matching needed to group these, unlike importParser.js's
 * by-show-title grouping for TV Time.
 */
function indexWatches(watches) {
  const episodeLogByTmdbId = {};
  const movieWatchedAtByTmdbId = {};

  for (const row of watches) {
    const tmdbId = parseIntOrNull(row.tmdb_id);
    if (!tmdbId) continue;

    if (row.type === "episode") {
      const season = parseIntOrNull(row.season_number);
      const episode = parseIntOrNull(row.episode_number);
      if (season === null || episode === null) continue;
      if (!episodeLogByTmdbId[tmdbId]) episodeLogByTmdbId[tmdbId] = [];
      episodeLogByTmdbId[tmdbId].push({
        season,
        episode,
        watchedAt: parseDateOrNull(row.first_watched_at || row.last_watched_at),
      });
    } else if (row.type === "movie") {
      // last_watched_at covers a rewatch (plays > 1) — closer to "the
      // last time I actually watched it" than the first viewing.
      const watchedAt = parseDateOrNull(row.last_watched_at || row.first_watched_at);
      const existing = movieWatchedAtByTmdbId[tmdbId];
      if (watchedAt && (!existing || watchedAt > existing)) {
        movieWatchedAtByTmdbId[tmdbId] = watchedAt;
      }
    }
  }

  return { episodeLogByTmdbId, movieWatchedAtByTmdbId };
}

function parseBingersExport(files) {
  const library = parseCsvFile(files["library.csv"] || "");
  const watches = parseCsvFile(files["watches.csv"] || "");
  const { episodeLogByTmdbId, movieWatchedAtByTmdbId } = indexWatches(watches);

  const shows = [];
  const movies = [];

  for (const row of library) {
    const tmdbId = parseIntOrNull(row.tmdb_id);
    const title = (row.title || "").trim();
    if (!tmdbId || !title) continue;

    // hidden_at/stopped_watching_at aren't documented anywhere public
    // (small real sample, neither ever populated in Kostas's test
    // account) — read defensively as "some value present means
    // true", the same defensive spirit importParser.js uses for
    // TV Time's own undocumented corners.
    const isHidden = !!row.hidden_at;
    const isStopped = !!row.stopped_watching_at;

    if (row.type === "show") {
      const episodeLog = episodeLogByTmdbId[tmdbId] || [];
      const latestWatchedAt = episodeLog.reduce(
        (latest, e) => (e.watchedAt && (!latest || e.watchedAt > latest) ? e.watchedAt : latest),
        null
      );
      shows.push({
        title,
        // Pre-matched — see file header. upsertShowProgress/matchShows
        // both only ever read show.match.*, so this is a drop-in
        // substitute for what matchShows() would have produced.
        match: { status: "matched", tmdbId, posterPath: null, confidence: 1, candidates: [] },
        episodesSeenCount: episodeLog.length,
        isFavorited: row.favorite === "yes",
        isFollowed: !isHidden,
        isArchived: isHidden || isStopped,
        rating: null,
        latestWatchedAt,
        // Real per-episode dates, not just a count — passed straight
        // through to upsertShowProgress/syncShowProgress's existing
        // episodeLog path (same shape importParser.js's episode-log
        // files produce: {season, episode, watchedAt}[]).
        episodeLog,
      });
    } else if (row.type === "movie") {
      const watchedAt = movieWatchedAtByTmdbId[tmdbId] || null;
      movies.push({
        title,
        tmdbId,
        watchedAt,
        isFavorited: row.favorite === "yes",
        isWatched: !!watchedAt,
      });
    }
    // Anything else (row.type neither "show" nor "movie") is left out
    // rather than guessed at.
  }

  return {
    shows,
    movies,
    stats: {
      totalShows: shows.length,
      totalMovies: movies.length,
      watchedMovies: movies.filter((m) => m.isWatched).length,
      showsWithEpisodeData: shows.filter((s) => s.episodesSeenCount > 0).length,
    },
  };
}

module.exports = { parseBingersExport };
