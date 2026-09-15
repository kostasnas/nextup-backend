// episodeComments.js
// Public comments on a specific episode — visible to ALL users, not
// just friends. This is the community-discussion feature meant to
// give Scenera the same "talk about the episode" value other
// trackers have, without needing an existing friend connection.
const { getPool } = require("./db");

/**
 * All comments for one episode, oldest first, with each commenter's
 * display name joined in directly — one query instead of N+1 lookups
 * per comment.
 */
async function getComments(episodeId) {
  const { rows } = await getPool().query(
    `select ec.id, ec.content, ec.created_at, ec.user_id,
            au.raw_user_meta_data->>'display_name' as display_name
     from episode_comments ec
     join auth.users au on au.id = ec.user_id
     where ec.episode_id = $1
     order by ec.created_at asc`,
    [episodeId]
  );
  return rows;
}

async function addComment(supabase, episodeId, userId, content) {
  const { data: comment, error } = await supabase
    .from("episode_comments")
    .insert({ episode_id: episodeId, user_id: userId, content })
    .select()
    .single();
  if (error) throw error;
  return comment;
}

/**
 * Deletes a comment — only the person who posted it can delete it.
 */
async function deleteComment(supabase, commentId, userId) {
  const { data: comment, error } = await supabase
    .from("episode_comments")
    .select("user_id")
    .eq("id", commentId)
    .single();
  if (error || !comment) {
    const e = new Error("Comment not found");
    e.status = 404;
    throw e;
  }
  if (comment.user_id !== userId) {
    const e = new Error("You can only delete your own comments");
    e.status = 403;
    throw e;
  }

  const { error: deleteError } = await supabase.from("episode_comments").delete().eq("id", commentId);
  if (deleteError) throw deleteError;

  return { ok: true };
}

/**
 * Comment counts for every episode of a show, in one query — used to
 * show a "12 comments" badge on each episode row without expanding
 * it, rather than fetching counts one episode at a time.
 */
async function getCommentCountsForShow(tmdbShowId) {
  const { rows } = await getPool().query(
    `select e.season_number, e.episode_number, count(ec.id)::int as comment_count
     from episodes e
     join shows s on s.id = e.show_id
     left join episode_comments ec on ec.episode_id = e.id
     where s.tmdb_id = $1
     group by e.season_number, e.episode_number`,
    [tmdbShowId]
  );
  return rows;
}

module.exports = { getComments, getCommentCountsForShow, addComment, deleteComment };
