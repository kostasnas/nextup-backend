// traktParser.js
// Parses a Trakt data export (the full account-export .zip you get from
// Trakt's settings) into the same {shows, movies, stats} shape the other
// *Parser.js files produce, for the same upsertShowProgress/syncShowProgress
// pipeline in server.js.
//
// The export is a big bundle of ~40 JSON files. Only a handful matter here:
//   - watched-shows.json   : one row per watched show (title, tmdb id, total
//                            play count) — the master list of what to import
//   - watched-history.json : one row per individual episode watch event,
//                            each with its own real watched_at — this is
//                            where the exact per-episode dates come from
//   - watched-movies.json  : same idea as watched-shows.json but for movies
//                            (empty in the sample this was built against —
//                            see caveat below)
//   - ratings-shows.json / ratings-movies.json : 1-10 rating, if the user
//                            rated the title
//   - lists-favorites.json : shows/movies the user marked as a favorite
//   - lists-watchlist.json : shows/movies tracked but not (fully) watched
//                            yet — { type: "show"|"movie", show/movie: {...},
//                            listed_at, ... }, one row per title
// Every entry already carries a real tmdb id (show.ids.tmdb /
// movie.ids.tmdb / episode.ids.tmdb) — no fuzzy title matching needed here
// either.
//
// SCOPE (v1): watched shows + their episode history, watched movies,
// ratings, favorites, and the watchlist (shows/movies not yet watched —
// imported as isFollowed/planned with zero progress, no per-episode data
// since none exists yet). Comments/notes files are present in the export
// too but out of scope for the same reason Movie Paradise's comments are —
// no place yet to stage them.
//
// CAVEAT: watched-movies.json was empty in every real sample this was
// built against, so its parsing below (mirroring watched-shows.json's
// shape) is unverified against real data — same best-effort spirit as
// movieParadiseParser.js's movie caveat.
//
// Built and verified against two real exports from Kostas's own Trakt
// account: the first confirmed watched-shows.json + watched-history.json
// (per-episode counts matched watched-shows.json's play counts exactly for
// all 3 shows), the second confirmed lists-watchlist.json's real shape
// (a show and a movie, both correctly picked up as not-yet-watched).

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

function parseJsonArray(fileContent) {
  if (!fileContent) return [];
  try {
    const parsed = JSON.parse(fileContent);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTraktExport(files) {
  const watchedShows = parseJsonArray(files["watched-shows.json"]);
  const watchedHistory = parseJsonArray(files["watched-history.json"]);
  const watchedMovies = parseJsonArray(files["watched-movies.json"]);
  const ratingsShows = parseJsonArray(files["ratings-shows.json"]);
  const ratingsMovies = parseJsonArray(files["ratings-movies.json"]);
  const favorites = parseJsonArray(files["lists-favorites.json"]);
  const watchlist = parseJsonArray(files["lists-watchlist.json"]);

  const ratingByShowTmdbId = {};
  for (const r of ratingsShows) {
    const tmdbId = parseIntOrNull(r.show?.ids?.tmdb);
    if (tmdbId) ratingByShowTmdbId[tmdbId] = parseIntOrNull(r.rating);
  }
  const ratingByMovieTmdbId = {};
  for (const r of ratingsMovies) {
    const tmdbId = parseIntOrNull(r.movie?.ids?.tmdb);
    if (tmdbId) ratingByMovieTmdbId[tmdbId] = parseIntOrNull(r.rating);
  }

  const favoritedShowIds = new Set(
    favorites.filter((f) => f.type === "show").map((f) => parseIntOrNull(f.show?.ids?.tmdb)).filter(Boolean)
  );
  const favoritedMovieIds = new Set(
    favorites.filter((f) => f.type === "movie").map((f) => parseIntOrNull(f.movie?.ids?.tmdb)).filter(Boolean)
  );

  // watched-history.json is the source of truth for exact per-episode
  // dates — grouped by the show's tmdb id so it can be joined onto each
  // watched-shows.json row below.
  const episodeLogByShowTmdbId = {};
  for (const entry of watchedHistory) {
    if (entry.type !== "episode" || !entry.episode || !entry.show) continue;
    const showTmdbId = parseIntOrNull(entry.show.ids?.tmdb);
    const season = parseIntOrNull(entry.episode.season);
    const episode = parseIntOrNull(entry.episode.number);
    if (!showTmdbId || season === null || episode === null) continue;
    if (!episodeLogByShowTmdbId[showTmdbId]) episodeLogByShowTmdbId[showTmdbId] = [];
    episodeLogByShowTmdbId[showTmdbId].push({ season, episode, watchedAt: parseDateOrNull(entry.watched_at) });
  }

  const shows = [];
  const seenShowTmdbIds = new Set();
  for (const entry of watchedShows) {
    const tmdbId = parseIntOrNull(entry.show?.ids?.tmdb);
    const title = (entry.show?.title || "").trim();
    if (!tmdbId || !title) continue;
    seenShowTmdbIds.add(tmdbId);

    const episodeLog = episodeLogByShowTmdbId[tmdbId] || [];
    const latestWatchedAt = episodeLog.reduce(
      (latest, e) => (e.watchedAt && (!latest || e.watchedAt > latest) ? e.watchedAt : latest),
      null
    );

    shows.push({
      title,
      match: { status: "matched", tmdbId, posterPath: null, confidence: 1, candidates: [] },
      // Prefer the exact history-derived count; fall back to Trakt's own
      // "plays" total if for some reason the history file didn't cover
      // this show (e.g. it was truncated on Trakt's end).
      episodesSeenCount: episodeLog.length > 0 ? episodeLog.length : parseIntOrNull(entry.plays) || 0,
      isFavorited: favoritedShowIds.has(tmdbId),
      isFollowed: true,
      isArchived: false,
      rating: ratingByShowTmdbId[tmdbId] ?? null,
      latestWatchedAt: latestWatchedAt || parseDateOrNull(entry.last_watched_at),
      episodeLog: episodeLog.length > 0 ? episodeLog : null,
    });
  }

  const movies = [];
  const seenMovieTmdbIds = new Set();
  for (const entry of watchedMovies) {
    const tmdbId = parseIntOrNull(entry.movie?.ids?.tmdb);
    const title = (entry.movie?.title || "").trim();
    if (!tmdbId || !title) continue;
    seenMovieTmdbIds.add(tmdbId);

    movies.push({
      title,
      tmdbId,
      isWatched: true,
      watchedAt: parseDateOrNull(entry.last_watched_at),
    });
  }

  // Watchlist: titles tracked but not yet watched — added as
  // zero-progress "followed"/"planned" entries, skipping anything
  // already picked up above from the watched lists.
  for (const entry of watchlist) {
    if (entry.type === "show") {
      const tmdbId = parseIntOrNull(entry.show?.ids?.tmdb);
      const title = (entry.show?.title || "").trim();
      if (!tmdbId || !title || seenShowTmdbIds.has(tmdbId)) continue;
      seenShowTmdbIds.add(tmdbId);
      shows.push({
        title,
        match: { status: "matched", tmdbId, posterPath: null, confidence: 1, candidates: [] },
        episodesSeenCount: 0,
        isFavorited: favoritedShowIds.has(tmdbId),
        isFollowed: true,
        isArchived: false,
        rating: ratingByShowTmdbId[tmdbId] ?? null,
        latestWatchedAt: null,
        episodeLog: null,
      });
    } else if (entry.type === "movie") {
      const tmdbId = parseIntOrNull(entry.movie?.ids?.tmdb);
      const title = (entry.movie?.title || "").trim();
      if (!tmdbId || !title || seenMovieTmdbIds.has(tmdbId)) continue;
      seenMovieTmdbIds.add(tmdbId);
      movies.push({
        title,
        tmdbId,
        isWatched: false,
        watchedAt: null,
      });
    }
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

module.exports = { parseTraktExport };
