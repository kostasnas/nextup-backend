// episodeRewatches.js
// Tracks rewatches separately from the original watched_episodes
// record — each row is one rewatch event, so counting is just
// counting rows.

const { getPool } = require("./db");

async function logRewatch(supabase, userId, episodeId) {
  const { error } = await supabase
    .from("episode_rewatches")
    .insert({ user_id: userId, episode_id: episodeId });
  if (error) throw error;
  return { ok: true };
}

// Undoes one accidental "log a rewatch" tap. Rows are interchangeable
// (each one just means "a rewatch happened", with nothing else worth
// distinguishing), so which specific row gets removed doesn't matter
// — only that the count goes down by exactly one.
async function removeRewatch(supabase, userId, episodeId) {
  const { data, error } = await supabase
    .from("episode_rewatches")
    .select("id")
    .eq("user_id", userId)
    .eq("episode_id", episodeId)
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return { ok: true, removed: false };

  const { error: deleteError } = await supabase
    .from("episode_rewatches")
    .delete()
    .eq("id", data[0].id);
  if (deleteError) throw deleteError;
  return { ok: true, removed: true };
}

/**
 * Rewatch counts for every episode of a show, in one query — same
 * "batch, not per-episode" pattern already used for comment counts,
 * so the episode list can show a rewatch badge without N+1 queries.
 */
async function getRewatchCountsForShow(userId, tmdbShowId) {
  const { rows } = await getPool().query(
    `select e.season_number, e.episode_number, count(er.id)::int as rewatch_count
     from episodes e
     join shows s on s.id = e.show_id
     join episode_rewatches er on er.episode_id = e.id and er.user_id = $2
     where s.tmdb_id = $1
     group by e.season_number, e.episode_number`,
    [tmdbShowId, userId]
  );
  return rows;
}

module.exports = { logRewatch, removeRewatch, getRewatchCountsForShow };
