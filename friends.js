// friends.js
// Friend connections — every read or write here is backend-mediated
// (unlike most of the rest of the app, which queries Supabase
// directly from the client). This is the one place personal data
// crosses between two different users' accounts, and that's much
// easier to get right — and to audit later — as a small set of
// explicit endpoints than as RLS policies trying to encode "only if
// accepted, only their favorites, never anyone else's."
const { findUserByEmail, getUserDisplayInfo } = require("./db");
const { sendPushToUser } = require("./pushNotifications");

/**
 * Sends a friend request by email. Deliberately returns the exact
 * same { ok: true } response whether or not an account with that
 * email exists, whether it's the person's own email, or whether a
 * connection already exists between the two — never revealing which
 * emails have accounts is more important here than telling the
 * sender exactly what happened.
 */
async function sendFriendRequest(supabase, requesterId, email) {
  const target = await findUserByEmail(email);
  if (!target || target.id === requesterId) {
    return { ok: true };
  }

  const { data: existing } = await supabase
    .from("friend_connections")
    .select("id")
    .or(`and(requester_id.eq.${requesterId},recipient_id.eq.${target.id}),and(requester_id.eq.${target.id},recipient_id.eq.${requesterId})`)
    .maybeSingle();
  if (existing) {
    return { ok: true };
  }

  await supabase.from("friend_connections").insert({
    requester_id: requesterId,
    recipient_id: target.id,
    status: "pending",
  });

  const requester = await getUserDisplayInfo(requesterId);
  const requesterName = requester?.display_name || requester?.email || "Someone";
  await sendPushToUser(supabase, target.id, {
    title: "New friend request",
    body: `${requesterName} wants to connect on Scenera`,
  });

  return { ok: true };
}

/**
 * Every connection the user is part of, split into three groups:
 * accepted friends, requests waiting on this user to respond to, and
 * requests this user sent that are still waiting on the other side.
 * The persistent pendingReceived list (shown on Profile) is what
 * catches a request even if its push notification was missed or
 * dismissed — nothing about accepting is time-sensitive.
 */
async function listFriends(supabase, userId) {
  const { data, error } = await supabase
    .from("friend_connections")
    .select("*")
    .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);
  if (error) throw error;

  const friends = [];
  const pendingReceived = [];
  const pendingSent = [];

  for (const row of data || []) {
    const otherId = row.requester_id === userId ? row.recipient_id : row.requester_id;
    const other = await getUserDisplayInfo(otherId);
    const entry = {
      connectionId: row.id,
      userId: otherId,
      name: other?.display_name || other?.email || "Unknown",
      avatarUrl: other?.avatar_url || null,
    };
    if (row.status === "accepted") {
      friends.push(entry);
    } else if (row.recipient_id === userId) {
      pendingReceived.push(entry);
    } else {
      pendingSent.push(entry);
    }
  }

  return { friends, pendingReceived, pendingSent };
}

async function acceptFriendRequest(supabase, connectionId, userId) {
  const { data: row, error } = await supabase.from("friend_connections").select("*").eq("id", connectionId).single();
  if (error || !row) { const e = new Error("Request not found"); e.status = 404; throw e; }
  if (row.recipient_id !== userId) { const e = new Error("Not your request to accept"); e.status = 403; throw e; }

  await supabase.from("friend_connections").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", connectionId);

  const accepter = await getUserDisplayInfo(userId);
  const accepterName = accepter?.display_name || accepter?.email || "Someone";
  await sendPushToUser(supabase, row.requester_id, {
    title: "Friend request accepted",
    body: `${accepterName} accepted your friend request`,
  });

  return { ok: true };
}

async function declineFriendRequest(supabase, connectionId, userId) {
  const { data: row, error } = await supabase.from("friend_connections").select("*").eq("id", connectionId).single();
  if (error || !row) { const e = new Error("Request not found"); e.status = 404; throw e; }
  if (row.recipient_id !== userId) { const e = new Error("Not your request to decline"); e.status = 403; throw e; }

  // Deleted rather than marked "declined" — no need to keep a record
  // around, and it lets the same person send a fresh request later
  // without a leftover row getting in the way.
  await supabase.from("friend_connections").delete().eq("id", connectionId);
  return { ok: true };
}

async function removeFriend(supabase, connectionId, userId) {
  const { data: row, error } = await supabase.from("friend_connections").select("*").eq("id", connectionId).single();
  if (error || !row) { const e = new Error("Connection not found"); e.status = 404; throw e; }
  if (row.requester_id !== userId && row.recipient_id !== userId) {
    const e = new Error("Not your connection"); e.status = 403; throw e;
  }

  await supabase.from("friend_connections").delete().eq("id", connectionId);
  return { ok: true };
}

/**
 * The whole point of the feature: a friend's favorited shows, and
 * only their favorited shows — never their full watchlist. Refuses
 * unless the connection is accepted AND the requesting user is
 * actually part of it.
 */
async function getFriendFavorites(supabase, connectionId, userId) {
  const { data: row, error } = await supabase.from("friend_connections").select("*").eq("id", connectionId).single();
  if (error || !row || row.status !== "accepted") {
    const e = new Error("Not an accepted friend connection"); e.status = 404; throw e;
  }
  if (row.requester_id !== userId && row.recipient_id !== userId) {
    const e = new Error("Not your connection"); e.status = 403; throw e;
  }

  const friendId = row.requester_id === userId ? row.recipient_id : row.requester_id;

  const { data: favorites, error: favError } = await supabase
    .from("user_watchlist")
    .select("shows(id, tmdb_id, title, poster_path)")
    .eq("user_id", friendId)
    .eq("is_favorite", true);
  if (favError) throw favError;

  return favorites || [];
}

module.exports = { sendFriendRequest, listFriends, acceptFriendRequest, declineFriendRequest, removeFriend, getFriendFavorites };
