// letterboxdParser.js
// Parses a Letterboxd data export (Settings -> Data -> Export Your
// Data on the Letterboxd website — not available in the mobile app)
// into the same {movies, stats} shape the other movie sources use.
//
// SCOPE: Letterboxd is films-only — there is no show/episode data at
// all, so this parser never returns a `shows` array. Movies come from
// three files: diary.csv (per-log-entry watches, with a real watched
// date and a 0.5-5 star rating), watched.csv (a flatter "ever
// watched" list, used as a fallback for any film that's in watched.csv
// but for some reason missing from diary.csv), and watchlist.csv
// (not-yet-watched, imported as unwatched "planned" movies).
//
// CAVEAT: Scenera's movie tracking (user_movie_watchlist, see
// movies.js) has no rating or "liked" column at all — only
// status ("planned"/"watched") and watched_at. Letterboxd's star
// ratings (ratings.csv, and the Rating column in diary.csv) and
// likes (likes/films.csv) are real data in the export but have
// nowhere to land yet, so they're counted in stats and skipped
// rather than silently dropped without a trace — same spirit as
// Movie Paradise's comments/reactions caveat.
//
// No TMDB IDs anywhere in a Letterboxd export (only Letterboxd's own
// URI slug) — every movie is matched by title AND year via
// tmdbMatcher.js's matchMovie(), which is why year is carried all the
// way through here instead of being dropped after parsing.
//
// Built and verified against a real (small) export from Kostas's own
// Letterboxd account.

const { parseCsvFile } = require("./importParser");

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

// Same title+year pair can legitimately appear in diary.csv,
// watched.csv and ratings.csv (they're overlapping views of the same
// account, not additive) — this is what a single movie gets deduped by.
function movieKey(name, year) {
  return `${name.trim().toLowerCase()}|${year || ""}`;
}

function parseLetterboxdExport(files) {
  const diary = parseCsvFile(files["diary.csv"] || "");
  const watched = parseCsvFile(files["watched.csv"] || "");
  const watchlist = parseCsvFile(files["watchlist.csv"] || "");
  const ratings = parseCsvFile(files["ratings.csv"] || "");
  const likes = parseCsvFile(files["likes/films.csv"] || "");

  const moviesByKey = new Map();
  let ratingsSkipped = 0;

  // diary.csv first — it's the richest source (real watched date +
  // rating per log entry, and covers rewatches watched.csv collapses
  // into a single row).
  for (const row of diary) {
    const title = (row.Name || "").trim();
    if (!title) continue;
    const year = parseIntOrNull(row.Year);
    const key = movieKey(title, year);
    const watchedAt = parseDateOrNull(row["Watched Date"] || row.Date);
    if (row.Rating) ratingsSkipped++;

    const existing = moviesByKey.get(key);
    // Keep the earliest watched date across multiple diary entries
    // (rewatches) for the same film — "when did I first see this",
    // matching how every other import source treats latestWatchedAt-
    // style fields for shows (real data, never overwritten by a guess).
    if (!existing || (watchedAt && (!existing.watchedAt || watchedAt < existing.watchedAt))) {
      moviesByKey.set(key, { title, year, isWatched: true, watchedAt: watchedAt || existing?.watchedAt || null });
    }
  }

  // watched.csv fallback — only adds films diary.csv didn't already
  // cover (e.g. logged before diary tracking existed on the account).
  for (const row of watched) {
    const title = (row.Name || "").trim();
    if (!title) continue;
    const year = parseIntOrNull(row.Year);
    const key = movieKey(title, year);
    if (moviesByKey.has(key)) continue;
    moviesByKey.set(key, { title, year, isWatched: true, watchedAt: parseDateOrNull(row.Date) });
  }

  // ratings.csv can include a rating for a film with no diary/watched
  // row at all (rated without logging a watch) — still counts as
  // "watched" (you can't rate something on Letterboxd without having
  // seen it), just with no real watched date.
  for (const row of ratings) {
    const title = (row.Name || "").trim();
    if (!title) continue;
    const year = parseIntOrNull(row.Year);
    const key = movieKey(title, year);
    if (!moviesByKey.has(key)) {
      moviesByKey.set(key, { title, year, isWatched: true, watchedAt: null });
      ratingsSkipped++;
    }
  }

  const watchedCount = moviesByKey.size;

  // watchlist.csv — not yet watched, imported as "planned".
  for (const row of watchlist) {
    const title = (row.Name || "").trim();
    if (!title) continue;
    const year = parseIntOrNull(row.Year);
    const key = movieKey(title, year);
    if (moviesByKey.has(key)) continue; // already watched (or since rewatched) takes priority
    moviesByKey.set(key, { title, year, isWatched: false, watchedAt: null });
  }

  const movies = Array.from(moviesByKey.values());

  return {
    movies,
    stats: {
      totalMovies: movies.length,
      watchedMovies: watchedCount,
      watchlistMovies: movies.length - watchedCount,
      ratingsSkipped, // Letterboxd star ratings we couldn't store anywhere
      likesSkipped: likes.length, // "liked" films — no equivalent concept for movies in Scenera yet
    },
  };
}

module.exports = { parseLetterboxdExport };
