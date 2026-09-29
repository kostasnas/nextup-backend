// simklParser.js
// Parses a Simkl "DOWNLOAD BACKUP" JSON export (SimklBackup.json,
// inside the .zip from simkl.com/apps/backup) into the same
// {shows, movies, stats} shape bingersParser.js/movieParadiseParser.js
// produce, for the same upsertShowProgress/syncShowProgress pipeline.
//
// Like Bingers and Movie Paradise, every show/movie already carries a
// real tmdb_id (under show.ids.tmdb / movie.ids.tmdb) — no fuzzy
// title matching needed.
//
// One genuine difference from the other two sources: Simkl only
// includes full per-episode data (seasons[].episodes[]) for shows
// that AREN'T fully completed — a show marked "completed" in the
// export (e.g. watched_episodes_count === total_episodes_count) has
// no seasons[] array at all, just the aggregate counts. That's not a
// gap to work around: upsertShowProgress/syncShowProgress already
// support exactly this "exact dates where we have them, count-based
// fallback for the rest" split (see episodeSync.js), so this just
// passes both through unchanged — episodeLog when Simkl gave us one,
// episodesSeenCount always.
//
// Built and verified against a real export from Kostas's own Simkl
// test account.

function parseIntOrNull(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

function parseDateOrNull(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const ARCHIVED_STATUSES = new Set(["dropped", "hold", "onhold", "not_interested", "notinteresting"]);

function parseSimklExport(files) {
  const raw = files["SimklBackup.json"];
  if (!raw) {
    return { shows: [], movies: [], stats: { totalShows: 0, totalMovies: 0, showsWithEpisodeData: 0, error: "SimklBackup.json not found in export" } };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { shows: [], movies: [], stats: { totalShows: 0, totalMovies: 0, showsWithEpisodeData: 0, error: `SimklBackup.json was not valid JSON: ${e.message}` } };
  }

  const shows = [];
  for (const entry of data.shows || []) {
    const tmdbId = parseIntOrNull(entry.show?.ids?.tmdb);
    const title = (entry.show?.title || "").trim();
    if (!tmdbId || !title) continue;

    const episodeLog = [];
    for (const season of entry.seasons || []) {
      const seasonNumber = parseIntOrNull(season.number);
      if (seasonNumber === null) continue;
      for (const ep of season.episodes || []) {
        const episodeNumber = parseIntOrNull(ep.number);
        if (episodeNumber === null) continue;
        episodeLog.push({ season: seasonNumber, episode: episodeNumber, watchedAt: parseDateOrNull(ep.watched_at) });
      }
    }

    // watched_episodes_count is the trustworthy total either way —
    // present whether or not Simkl included per-episode detail for
    // this particular show (see file header).
    const episodesSeenCount = parseIntOrNull(entry.watched_episodes_count) || episodeLog.length;
    const status = (entry.status || "").toLowerCase();

    shows.push({
      title,
      match: { status: "matched", tmdbId, posterPath: null, confidence: 1, candidates: [] },
      episodesSeenCount,
      isFavorited: false,
      isFollowed: !ARCHIVED_STATUSES.has(status),
      isArchived: ARCHIVED_STATUSES.has(status),
      rating: parseIntOrNull(entry.user_rating),
      latestWatchedAt: parseDateOrNull(entry.last_watched_at),
      // Only non-empty when Simkl actually gave us per-episode dates —
      // upsertShowProgress/episodeSync.js already treat an empty/null
      // log as "use the count-based fallback", so no special-casing
      // needed here for the "completed, no seasons[]" case.
      episodeLog: episodeLog.length > 0 ? episodeLog : null,
    });
  }

  const movies = [];
  for (const entry of data.movies || []) {
    const tmdbId = parseIntOrNull(entry.movie?.ids?.tmdb);
    const title = (entry.movie?.title || "").trim();
    if (!tmdbId || !title) continue;

    const status = (entry.status || "").toLowerCase();
    movies.push({
      title,
      tmdbId,
      isWatched: status === "completed",
      watchedAt: parseDateOrNull(entry.last_watched_at),
    });
  }

  return {
    shows,
    movies,
    stats: {
      totalShows: shows.length,
      totalMovies: movies.length,
      showsWithEpisodeData: shows.filter((s) => s.episodeLog && s.episodeLog.length > 0).length,
      watchedMovies: movies.filter((m) => m.isWatched).length,
    },
  };
}

module.exports = { parseSimklExport };
