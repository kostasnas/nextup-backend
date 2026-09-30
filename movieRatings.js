// movieRatings.js
// A Scenera-wide "average rating" for a movie, aggregated from every
// user's own 1-5 star rating (user_movie_watchlist.rating) — the
// movie-side equivalent of showRatings.js's getShowCommunityRating.
// Distinct from TMDB's own vote_average (that's TMDB's whole
// audience) and from the Rotten Tomatoes score (rottenTomatoes.js,
// critics/RT's own audience) — this is specifically Scenera's users.
const { getPool } = require("./db");

async function getMovieCommunityRating(tmdbMovieId) {
  const { rows } = await getPool().query(
    `select avg(umw.rating)::float as average, count(umw.rating)::int as count
     from user_movie_watchlist umw
     join movies m on m.id = umw.movie_id
     where m.tmdb_id = $1 and umw.rating is not null`,
    [tmdbMovieId]
  );
  const row = rows[0];
  return {
    average: row?.average ? Math.round(row.average * 10) / 10 : null,
    count: row?.count || 0,
  };
}

module.exports = { getMovieCommunityRating };
