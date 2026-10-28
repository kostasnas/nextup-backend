// messages.js
// Direct messages between two friends — only allowed once a
// friend_connections row exists with status "accepted". Every read
// or write here re-checks that, same reasoning as friends.js: this
// is personal data crossing between two accounts, worth getting
// right as a small set of explicit, audited endpoints rather than
// RLS policies trying to encode "only if accepted, only between
// these two people."
const { getUserDisplayInfo, getPool } = require("./db");
const { sendPushToUser } = require("./pushNotifications");

// A card for an episode, movie or show that rides along with a message. Anything that does not look right is dropped
// (returns null) rather than failing the message: the text still goes through.
function cleanRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  const kind = ref.kind === "episode" || ref.kind === "movie" || ref.kind === "show" ? ref.kind : null;
  const tmdbId = Number.isInteger(ref.tmdbId) && ref.tmdbId > 0 ? ref.tmdbId : null;
  if (!kind || !tmdbId) return null;
  const title = typeof ref.title === "string" ? ref.title.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  if (!title) return null;
  let season = null;
  let episode = null;
  if (kind === "episode") {
    season = Number.isInteger(ref.season) && ref.season >= 0 && ref.season < 1000 ? ref.season : null;
    episode = Number.isInteger(ref.episode) && ref.episode > 0 && ref.episode < 100000 ? ref.episode : null;
    if (season == null || episode == null) return null;
  }
  const poster = typeof ref.posterPath === "string" && /^\/[A-Za-z0-9._-]{3,80}$/.test(ref.posterPath) ? ref.posterPath : null;
  return { kind, tmdbId, season, episode, title, poster };
}

const refLabel = (r) => (r.kind === "episode" ? `${r.title} S${r.season}E${r.episode}` : r.title);

async function sendMessage(supabase, connectionId, senderId, content, rawRef = null) {
  const ref = cleanRef(rawRef);
  const { data: connection, error } = await supabase
    .from("friend_connections")
    .select("*")
    .eq("id", connectionId)
    .single();
  if (error || !connection || connection.status !== "accepted") {
    const e = new Error("Not an accepted friend connection");
    e.status = 404;
    throw e;
  }
  if (connection.requester_id !== senderId && connection.recipient_id !== senderId) {
    const e = new Error("Not your connection");
    e.status = 403;
    throw e;
  }

  const { data: message, error: insertError } = await supabase
    .from("messages")
    .insert({
      connection_id: connectionId, sender_id: senderId, content,
      ...(ref ? { ref_kind: ref.kind, ref_tmdb_id: ref.tmdbId, ref_season: ref.season, ref_episode: ref.episode, ref_title: ref.title, ref_poster: ref.poster } : {}),
    })
    .select()
    .single();
  if (insertError) {
    // Before migrations/messages_media_ref.sql has been run the card columns do not exist.
    if (ref && /ref_/.test(String(insertError.message))) {
      const e = new Error("Sending an episode to a friend is not available yet.");
      e.status = 503;
      throw e;
    }
    throw insertError;
  }

  const recipientId = connection.requester_id === senderId ? connection.recipient_id : connection.requester_id;
  const sender = await getUserDisplayInfo(senderId);
  const senderName = sender?.display_name || sender?.email || "Someone";
  // What the notification says. A card about an episode or movie the friend has not watched must not show the text the
  // sender wrote (it can spoil it): then the notification only says that there is a message about it. If it cannot be
  // worked out whether it was watched, the text stays hidden.
  let text = ref ? (content ? `${refLabel(ref)}: ${content}` : refLabel(ref)) : content;
  if (ref && ref.kind !== "show") {
    const [checked] = await annotateWatched([{ ref_kind: ref.kind, ref_tmdb_id: ref.tmdbId, ref_season: ref.season, ref_episode: ref.episode, sender_id: senderId }], recipientId);
    if (!checked || checked.ref_watched !== true) text = ref.kind === "movie" ? "Sent you a message about a movie" : "Sent you a message about an episode";
  }
  const push = await sendPushToUser(supabase, recipientId, {
    title: senderName,
    body: text.length > 100 ? text.slice(0, 100) + "…" : text,
    data: { type: "friend_message", connectionId: String(connectionId), friendName: senderName },
  });
  // Written down, so a message that "never arrived" can be traced: no token saved for the friend, or the send itself failed.
  console.log(`friend message push: connection ${connectionId} targeted ${push?.devicesTargeted ?? "?"}, ok ${push?.successCount ?? "-"}, failed ${push?.failureCount ?? "-"}${push?.error ? `, error ${push.error}` : ""}`);

  return message;
}

/**
 * Full message history for a connection, oldest first — the whole
 * conversation, since there's no pagination yet in this first
 * version. Fine for now; worth revisiting once conversations get
 * genuinely long.
 */
async function getMessages(supabase, connectionId, userId) {
  const { data: connection, error } = await supabase
    .from("friend_connections")
    .select("*")
    .eq("id", connectionId)
    .single();
  if (error || !connection) {
    const e = new Error("Connection not found");
    e.status = 404;
    throw e;
  }
  if (connection.requester_id !== userId && connection.recipient_id !== userId) {
    const e = new Error("Not your connection");
    e.status = 403;
    throw e;
  }

  // Reading the conversation is what marks the other person's messages as delivered and read
  // (the double ticks on their side). Best effort: before migrations/messages_receipts.sql has been run the
  // columns do not exist, the update just fails, and the chat works as it did.
  const now = new Date().toISOString();
  await supabase.from("messages").update({ delivered_at: now }).eq("connection_id", connectionId).neq("sender_id", userId).is("delivered_at", null);
  await supabase.from("messages").update({ read_at: now }).eq("connection_id", connectionId).neq("sender_id", userId).is("read_at", null);

  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("*")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: true });
  if (msgError) throw msgError;

  return annotateWatched(messages || [], userId);
}

/**
 * For the cards in a conversation: has the person reading it already watched what the card is about? The chat blurs the
 * text of a card message the reader has not watched yet (a spoiler). Only messages sent by the other person get the flag
 * (ref_watched true / false); everything else is left as it is. If anything goes wrong the flag is simply missing and
 * nothing is blurred.
 */
async function annotateWatched(messages, userId) {
  const cards = messages.filter((m) => m.ref_kind && m.sender_id !== userId);
  if (cards.length === 0) return messages;
  try {
    const pool = getPool();
    const episodes = [...new Map(cards.filter((m) => m.ref_kind === "episode")
      .map((m) => [`${m.ref_tmdb_id}:${m.ref_season}:${m.ref_episode}`, m])).values()];
    const movies = [...new Set(cards.filter((m) => m.ref_kind === "movie").map((m) => m.ref_tmdb_id))];
    const watched = new Set();
    if (episodes.length) {
      const { rows } = await pool.query(
        `select s.tmdb_id, e.season_number, e.episode_number
           from watched_episodes we
           join episodes e on e.id = we.episode_id
           join shows s on s.id = e.show_id
          where we.user_id = $1 and s.tmdb_id = any($2::int[])`,
        [userId, [...new Set(episodes.map((m) => m.ref_tmdb_id))]]
      );
      for (const r of rows) watched.add(`${r.tmdb_id}:${r.season_number}:${r.episode_number}`);
    }
    if (movies.length) {
      const { rows } = await pool.query(
        `select m.tmdb_id
           from user_movie_watchlist w
           join movies m on m.id = w.movie_id
          where w.user_id = $1 and w.status = 'watched' and m.tmdb_id = any($2::int[])`,
        [userId, movies]
      );
      for (const r of rows) watched.add(`movie:${r.tmdb_id}`);
    }
    return messages.map((m) => {
      if (!m.ref_kind || m.sender_id === userId) return m;
      if (m.ref_kind === "show") return { ...m, ref_watched: true }; // a whole show: nothing to spoil
      const key = m.ref_kind === "movie" ? `movie:${m.ref_tmdb_id}` : `${m.ref_tmdb_id}:${m.ref_season}:${m.ref_episode}`;
      return { ...m, ref_watched: watched.has(key) };
    });
  } catch (e) {
    console.error("annotateWatched failed:", e.message);
    return messages;
  }
}

/**
 * The app calls this when it opens or comes back to the foreground (and when a message push arrives while it is
 * open): every message sent to this person that had not reached the app yet gets delivered_at, which is the
 * second grey tick for the sender. Not "read" - that only happens when the conversation is opened (getMessages).
 */
async function markDelivered(supabase, userId) {
  const { data: connections } = await supabase
    .from("friend_connections")
    .select("id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);
  const ids = (connections || []).map((c) => c.id);
  if (ids.length === 0) return { ok: true };
  await supabase
    .from("messages")
    .update({ delivered_at: new Date().toISOString() })
    .in("connection_id", ids)
    .neq("sender_id", userId)
    .is("delivered_at", null);
  return { ok: true };
}

/**
 * Deletes a message — only the person who sent it can delete it, and
 * it's removed for both people in the conversation (no "delete for
 * me only" in this first version).
 */
async function deleteMessage(supabase, messageId, userId) {
  const { data: message, error } = await supabase
    .from("messages")
    .select("sender_id")
    .eq("id", messageId)
    .single();
  if (error || !message) {
    const e = new Error("Message not found");
    e.status = 404;
    throw e;
  }
  if (message.sender_id !== userId) {
    const e = new Error("You can only delete your own messages");
    e.status = 403;
    throw e;
  }

  const { error: deleteError } = await supabase.from("messages").delete().eq("id", messageId);
  if (deleteError) throw deleteError;

  return { ok: true };
}

module.exports = { sendMessage, getMessages, deleteMessage, markDelivered, cleanRef };
