// sofaTimeParser.js
// Parses a Sofa Time export (6 JSON files inside a zip:
// watchlistShow, watchedShow, stopWatchingShow, watchlistMovie,
// watchedMovie, stopWatchingMovie — each with a timestamp suffix in
// its real filename, normalized away before this runs) into the same
// {shows, movies, stats} shape the other *Parser.js files produce.
// Every entry already carries a real tmdb id — no fuzzy title
// matching needed here either.
//
// Two files split what Bingers/Simkl keep in one place:
//   - watchlistShow/Movie: what's being tracked (this is the master
//     list of titles — same role as Bingers' library.csv)
//   - watchedShow/Movie: same show/movie objects, but each nested
//     episode carries the date IT was watched (or the movie's own
//     addedDate marks when it was watched)
//   - stopWatchingShow/Movie: dropped/archived titles
// A title can appear in more than one of these (e.g. tracked AND
// partway watched) — every list is folded into one map keyed by
// tmdb_id before building the final shows/movies arrays.
//
// One real wrinkle: a "mark whole series watched" bulk action in
// Sofa Time stamps every episode's date as the Unix epoch
// (1970-01-01T00:00:00Z) — clearly a "no real date" placeholder, not
// an actual watch date, so treating it as literal would insert
// obviously wrong history ("watched in 1970"). Those episodes still
// count toward episodesSeenCount (the show genuinely was watched),
// they just don't go into the exact-date episodeLog — falling back
// to the same count-based fill the pipeline already uses whenever a
// source doesn't have real per-episode dates (see episodeSync.js).
//
// Built and verified against a real export from Kostas's own Sofa
// Time test account.

function parseIntOrNull(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

const EPOCH_PLACEHOLDER = "1970-01-01";

function parseRealDateOrNull(val) {
  if (!val || typeof val !== "string" || val.startsWith(EPOCH_PLACEHOLDER)) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseJsonArray(fileContent) {
  if (!fileContent) return [];
  try {
    const parsed = JSON.parse(fileContent);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseSofaTimeExport(files) {
  const watchlistShows = parseJsonArray(files["watchlistShow.json"]);
  const watchedShows = parseJsonArray(files["watchedShow.json"]);
  const stoppedShows = parseJsonArray(files["stopWatchingShow.json"]);
  const watchlistMovies = parseJsonArray(files["watchlistMovie.json"]);
  const watchedMovies = parseJsonArray(files["watchedMovie.json"]);
  const stoppedMovies = parseJsonArray(files["stopWatchingMovie.json"]);

  const stoppedShowIds = new Set(stoppedShows.map((s) => parseIntOrNull(s.tmdb)).filter(Boolean));
  const stoppedMovieIds = new Set(stoppedMovies.map((m) => parseIntOrNull(m.tmdb)).filter(Boolean));

  // One row per show, merging the watchlist entry (title/addedDate)
  // with the watched entry (episode-level data), keyed by tmdb id —
  // a show can be in either, both, or (rare) neither list this
  // covers (e.g. only in stopWatchingShow, still worth importing as
  // dropped rather than silently skipped).
  const showsById = new Map();
  const ensureShow = (raw) => {
    const tmdbId = parseIntOrNull(raw.tmdb);
    if (!tmdbId || !raw.title) return null;
    if (!showsById.has(tmdbId)) {
      showsById.set(tmdbId, { tmdbId, title: raw.title.trim(), episodeLog: [], episodesSeenCount: 0 });
    }
    return showsById.get(tmdbId);
  };

  for (const raw of watchlistShows) ensureShow(raw);
  for (const raw of stoppedShows) ensureShow(raw);

  for (const raw of watchedShows) {
    const entry = ensureShow(raw);
    if (!entry) continue;
    let seenCount = 0;
    for (const season of raw.seasons || []) {
      const seasonNumber = parseIntOrNull(season.number);
      if (seasonNumber === null) continue;
      for (const ep of season.episodes || []) {
        const episodeNumber = parseIntOrNull(ep.number);
        if (episodeNumber === null) continue;
        seenCount++;
        const watchedAt = parseRealDateOrNull(ep.addedDate);
        if (watchedAt) entry.episodeLog.push({ season: seasonNumber, episode: episodeNumber, watchedAt });
      }
    }
    entry.episodesSeenCount = seenCount;
  }

  const shows = Array.from(showsById.values()).map((s) => ({
    title: s.title,
    match: { status: "matched", tmdbId: s.tmdbId, posterPath: null, confidence: 1, candidates: [] },
    episodesSeenCount: s.episodesSeenCount,
    isFavorited: false,
    isFollowed: !stoppedShowIds.has(s.tmdbId),
    isArchived: stoppedShowIds.has(s.tmdbId),
    rating: null,
    latestWatchedAt: s.episodeLog.reduce((latest, e) => (!latest || e.watchedAt > latest ? e.watchedAt : latest), null),
    episodeLog: s.episodeLog.length > 0 ? s.episodeLog : null,
  }));

  // Movies: watchlist entries are "planned", watched entries are
  // "watched" with the entry's own addedDate as the watched date
  // (no per-movie sample with a real date to confirm against, but
  // the same field name/shape as shows' addedDate — same best-effort
  // spirit as importParser.js's movie caveat).
  const moviesById = new Map();
  const ensureMovie = (raw) => {
    const tmdbId = parseIntOrNull(raw.tmdb);
    if (!tmdbId || !raw.title) return null;
    if (!moviesById.has(tmdbId)) {
      moviesById.set(tmdbId, { tmdbId, title: raw.title.trim(), isWatched: false, watchedAt: null });
    }
    return moviesById.get(tmdbId);
  };
  for (const raw of watchlistMovies) ensureMovie(raw);
  for (const raw of stoppedMovies) ensureMovie(raw);
  for (const raw of watchedMovies) {
    const entry = ensureMovie(raw);
    if (!entry) continue;
    entry.isWatched = true;
    entry.watchedAt = parseRealDateOrNull(raw.addedDate);
  }

  const movies = Array.from(moviesById.values());

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

module.exports = { parseSofaTimeExport };
