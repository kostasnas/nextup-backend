// episodeEmotions.js
// Public "Emotion Vote" tally — how everyone (not just you) reacted
// to a specific episode. The personal side of this already existed:
// watched_episodes.reaction has been there since the TV Time import
// (episodeSync.js) and ShowDetailScreen already lets someone set
// their own reaction directly via supabase-js (no backend round-trip
// needed for that part — same pattern as rewatch logging). What was
// missing, and what other TV trackers' Discord comparison table
// calls out as "Emotion Vote", is a PUBLIC breakdown — same shape as
// the existing Fictional Character Vote tally, just for reactions
// instead of cast picks.
//
// No new table: reaction values already live on watched_episodes,
// across whatever keys the client has ever written there (the richer
// emotion set ShowDetailScreen's picker offers now, "loved"/"funny"/
// "shocked"/"sad"/"mad"/"mindblown", plus legacy "up"/"down" from
// older TV Time imports) — this just counts them, grouped per episode.
const { getPool } = require("./db");

/**
 * Reaction counts for every episode of a show, in one query — same
 * "batch per show" pattern as getCommentCountsForShow/
 * getRewatchCountsForShow, so the episode list can show "😍 12 · 😱 4"
 * without an N+1 query per episode. Deliberately NOT scoped to one
 * user — this is the public tally, unlike the personal `reaction`
 * read already done elsewhere in ShowDetailScreen.
 */
async function getEmotionCountsForShow(tmdbShowId) {
  const { rows } = await getPool().query(
    `select e.season_number, e.episode_number, we.reaction, count(*)::int as count
     from episodes e
     join shows s on s.id = e.show_id
     join watched_episodes we on we.episode_id = e.id
     where s.tmdb_id = $1 and we.reaction is not null
     group by e.season_number, e.episode_number, we.reaction`,
    [tmdbShowId]
  );
  return rows;
}

module.exports = { getEmotionCountsForShow };
