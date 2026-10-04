// imdbParser.js
// Parses an IMDb "ratings" export (IMDb profile -> Your ratings -> Export,
// a single ratings.csv — not a zip, unlike every other import source here)
// into the same {shows, movies, stats} shape the rest of the import
// pipeline expects.
//
// Unlike TV Time (importParser.js) or Letterboxd (letterboxdParser.js),
// every row already carries IMDb's own id (the Const column, "tt1234567")
// — resolved to a TMDB id via tmdbMatcher.js's findByImdbId, a direct
// lookup with no fuzzy title matching and no confidence threshold.
//
// SCOPE / CAVEAT: this is a *ratings* export, not a watch-history export
// — IMDb doesn't offer per-episode watch history at all. A rating is
// treated as "watched" (you can't rate a title on IMDb without having
// seen it — same assumption letterboxdParser.js makes for ratings.csv).
// For a "TV Series"/"TV Mini Series" row, the rating is for the show as
// a whole: there's no season/episode breakdown here, so these import
// with zero episode-level data (no episodeLog, episodesSeenCount: 0) —
// the caller marks them watched at the show level rather than guessing
// which episodes. A "TV Episode" row (someone rated an individual
// episode rather than the whole series) is skipped entirely: the file
// has no parent-show id to attach it to reliably, only a free-text
// title.
//
// Built against a real export from Kostas's own IMDb account (4 Oct
// 2026) — 2 movies, 2 TV series, all with Const/Title Type/Date Rated
// populated as expected.

const { parseCsvFile } = require("./importParser");

const MOVIE_TITLE_TYPES = new Set(["Movie", "TV Movie", "Video", "Short", "TV Special"]);
const SHOW_TITLE_TYPES = new Set(["TV Series", "TV Mini Series"]);

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

function parseImdbRatingsExport(fileContent) {
  const rows = parseCsvFile(fileContent);

  const movies = [];
  const shows = [];
  let episodesSkipped = 0;
  let unknownTypeSkipped = 0;

  for (const row of rows) {
    const imdbId = (row.Const || "").trim();
    const title = (row.Title || "").trim();
    if (!imdbId || !title) continue;

    const titleType = (row["Title Type"] || "").trim();
    const rating = parseIntOrNull(row["Your Rating"]);
    const watchedAt = parseDateOrNull(row["Date Rated"]);
    const year = parseIntOrNull(row.Year);

    if (MOVIE_TITLE_TYPES.has(titleType)) {
      movies.push({ title, imdbId, year, rating, watchedAt });
    } else if (SHOW_TITLE_TYPES.has(titleType)) {
      shows.push({ title, imdbId, year, rating, watchedAt });
    } else if (titleType === "TV Episode") {
      episodesSkipped++;
    } else {
      unknownTypeSkipped++;
    }
  }

  return {
    movies,
    shows,
    stats: {
      totalMovies: movies.length,
      totalShows: shows.length,
      episodesSkipped, // individual-episode ratings — no parent-show id in this file to attach them to
      unknownTypeSkipped,
    },
  };
}

module.exports = { parseImdbRatingsExport };
