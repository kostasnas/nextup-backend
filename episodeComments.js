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
async function getComments(episodeId, userId) {
  const { rows } = await getPool().query(
    `select ec.id, ec.content, ec.created_at, ec.user_id, ec.image_url,
            au.raw_user_meta_data->>'display_name' as display_name,
            count(cl.id)::int as like_count,
            bool_or(cl.user_id = $2) as liked_by_me
     from episode_comments ec
     join auth.users au on au.id = ec.user_id
     left join comment_likes cl on cl.comment_id = ec.id
     where ec.episode_id = $1
     group by ec.id, au.raw_user_meta_data
     order by ec.created_at asc`,
    [episodeId, userId || null]
  );
  return rows;
}

/**
 * Toggles a like on a comment. Notifies the comment's author (unless
 * they're liking their own comment) the first time this user likes
 * it — no notification on unlike, and no re-notify if they unlike
 * then like again isn't worth guarding against, it's an edge case
 * that just means one extra "liked your comment" ping.
 */
async function toggleCommentLike(supabase, userId, commentId) {
  const { data: comment, error: commentError } = await supabase
    .from("episode_comments")
    .select("user_id, episode_id")
    .eq("id", commentId)
    .single();
  if (commentError || !comment) {
    const e = new Error("Comment not found");
    e.status = 404;
    throw e;
  }

  const { data: existing, error: findError } = await supabase
    .from("comment_likes")
    .select("id")
    .eq("comment_id", commentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (findError) throw findError;

  let liked;
  if (existing) {
    const { error } = await supabase.from("comment_likes").delete().eq("id", existing.id);
    if (error) throw error;
    liked = false;
  } else {
    const { error } = await supabase.from("comment_likes").insert({ comment_id: commentId, user_id: userId });
    if (error) throw error;
    liked = true;
  }

  const { count } = await supabase
    .from("comment_likes")
    .select("id", { count: "exact", head: true })
    .eq("comment_id", commentId);

  return { liked, likeCount: count || 0, commentAuthorId: comment.user_id, episodeId: comment.episode_id };
}

/**
 * Show title + season/episode number for one episode — just enough
 * to write a readable "liked your comment on ..." notification body,
 * not a general-purpose episode lookup.
 */
async function getEpisodeContext(episodeId) {
  const { rows } = await getPool().query(
    `select s.title as show_title, e.season_number, e.episode_number
     from episodes e
     join shows s on s.id = e.show_id
     where e.id = $1`,
    [episodeId]
  );
  return rows[0] || null;
}

async function addComment(supabase, episodeId, userId, content, imageUrl) {
  const { data: comment, error } = await supabase
    .from("episode_comments")
    .insert({ episode_id: episodeId, user_id: userId, content, image_url: imageUrl || null })
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

module.exports = { getComments, getCommentCountsForShow, addComment, deleteComment, toggleCommentLike, getEpisodeContext };
