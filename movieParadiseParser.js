// movieParadiseParser.js
// Parses a Movie Paradise data export into the same {shows, movies,
// stats} shape bingersParser.js/importParser.js produce, for the same
// upsertShowProgress/syncShowProgress pipeline in server.js.
//
// Movie Paradise's export bundles everything into one data.json
// (alongside individual CSVs that just restate the same data) — this
// reads data.json directly rather than reassembling it from CSVs,
// since it's already structured and typed. Like Bingers, every show
// and movie already carries a real tmdb_id, so there's no fuzzy
// title matching step here either.
//
// SCOPE (v1): shows (library + per-episode watch dates from
// `episodes[]`) and movies (best-effort — see caveat below). NOT yet
// imported: `comments[]` (episode comments/GIFs) and
// `episodeReactions[]` (favorite character + emotion tags) — both are
// genuinely importable from this export, but need follow-up work
// (comments need a place to stage them until episode rows exist
// post-sync; character favorites need a new TMDB person-search step
// to resolve "Tom Hardy" -> a tmdb_person_id). Flagged in stats so
// nothing is silently dropped without a trace.
//
// Built and verified against a real export from Kostas's own Movie
// Paradise test account.

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

function parseMovieParadiseExport(files) {
  const raw = files["data.json"];
  if (!raw) {
    return { shows: [], movies: [], stats: { totalShows: 0, totalMovies: 0, showsWithEpisodeData: 0, skippedComments: 0, skippedReactions: 0, error: "data.json not found in export" } };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { shows: [], movies: [], stats: { totalShows: 0, totalMovies: 0, showsWithEpisodeData: 0, skippedComments: 0, skippedReactions: 0, error: `data.json was not valid JSON: ${e.message}` } };
  }

  const episodeLogByShowTmdbId = {};
  for (const ep of data.episodes || []) {
    if (!ep.showTmdbId || !ep.watched) continue;
    const season = parseIntOrNull(ep.season);
    const episode = parseIntOrNull(ep.episode);
    if (season === null || episode === null) continue;
    if (!episodeLogByShowTmdbId[ep.showTmdbId]) episodeLogByShowTmdbId[ep.showTmdbId] = [];
    episodeLogByShowTmdbId[ep.showTmdbId].push({ season, episode, watchedAt: parseDateOrNull(ep.watchedAt) });
  }

  const shows = [];
  const movies = [];

  for (const item of data.library || []) {
    const tmdbId = parseIntOrNull(item.tmdbId);
    const title = (item.title || "").trim();
    if (!tmdbId || !title) continue;

    const status = (item.status || "").toLowerCase();

    if (item.type === "tv") {
      const episodeLog = episodeLogByShowTmdbId[tmdbId] || [];
      const latestWatchedAt = episodeLog.reduce(
        (latest, e) => (e.watchedAt && (!latest || e.watchedAt > latest) ? e.watchedAt : latest),
        null
      );
      shows.push({
        title,
        match: { status: "matched", tmdbId, posterPath: null, confidence: 1, candidates: [] },
        episodesSeenCount: episodeLog.length,
        isFavorited: false,
        isFollowed: status !== "dropped" && status !== "hidden",
        isArchived: status === "dropped" || status === "hidden",
        rating: null,
        latestWatchedAt,
        episodeLog,
      });
    } else if (item.type === "movie") {
      // CAVEAT: the real sample this was built against had no watched
      // movie to verify the exact status string against ("watched" is
      // a guess based on the "toWatch" value actually seen) — same
      // best-effort spirit as importParser.js's movie caveat. Safe
      // either way: worst case a watched movie lands in the "planned"
      // list instead of "watched", never lost entirely.
      movies.push({
        title,
        tmdbId,
        isWatched: status === "watched",
        watchedAt: parseDateOrNull(item.watchedAt),
      });
    }
  }

  // Comments need an episode number to import at all — Scenera has no
  // show/season-level comment concept. Not wired into the import
  // pipeline yet (see file header) — counted here so the caller can
  // tell the person honestly how many exist vs. how many we could
  // actually bring in once that's built.
  const importableComments = (data.comments || []).filter(
    (c) => c.type === "tv" && c.tmdbId && c.season != null && c.episode != null
  ).length;
  const skippedComments = (data.comments || []).length - importableComments;

  return {
    shows,
    movies,
    stats: {
      totalShows: shows.length,
      totalMovies: movies.length,
      showsWithEpisodeData: shows.filter((s) => s.episodesSeenCount > 0).length,
      watchedMovies: movies.filter((m) => m.isWatched).length,
      totalComments: (data.comments || []).length,
      importableComments,
      skippedComments,
      skippedReactions: (data.episodeReactions || []).length,
    },
  };
}

module.exports = { parseMovieParadiseExport };
