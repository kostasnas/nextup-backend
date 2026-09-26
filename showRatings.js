// showRatings.js
// A Scenera-wide "average rating" for a show, aggregated from every
// user's own 1-5 star rating (user_watchlist.rating) — the same data
// already collected for each user's personal rating, just rolled up
// across everyone instead of scoped to one person. Distinct from
// TMDB's own vote_average, which reflects TMDB's whole audience, not
// Scenera's.
const { getPool } = require("./db");

async function getShowCommunityRating(tmdbShowId) {
  const { rows } = await getPool().query(
    `select avg(uw.rating)::float as average, count(uw.rating)::int as count
     from user_watchlist uw
     join shows s on s.id = uw.show_id
     where s.tmdb_id = $1 and uw.rating is not null`,
    [tmdbShowId]
  );
  const row = rows[0];
  return {
    average: row?.average ? Math.round(row.average * 10) / 10 : null,
    count: row?.count || 0,
  };
}

module.exports = { getShowCommunityRating };
