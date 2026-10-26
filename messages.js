// messages.js
// Direct messages between two friends — only allowed once a
// friend_connections row exists with status "accepted". Every read
// or write here re-checks that, same reasoning as friends.js: this
// is personal data crossing between two accounts, worth getting
// right as a small set of explicit, audited endpoints rather than
// RLS policies trying to encode "only if accepted, only between
// these two people."
const { getUserDisplayInfo } = require("./db");
const { sendPushToUser } = require("./pushNotifications");

async function sendMessage(supabase, connectionId, senderId, content) {
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
    .insert({ connection_id: connectionId, sender_id: senderId, content })
    .select()
    .single();
  if (insertError) throw insertError;

  const recipientId = connection.requester_id === senderId ? connection.recipient_id : connection.requester_id;
  const sender = await getUserDisplayInfo(senderId);
  const senderName = sender?.display_name || sender?.email || "Someone";
  await sendPushToUser(supabase, recipientId, {
    title: senderName,
    body: content.length > 100 ? content.slice(0, 100) + "…" : content,
    data: { type: "friend_message", connectionId: String(connectionId), friendName: senderName },
  });

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

  return messages || [];
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

module.exports = { sendMessage, getMessages, deleteMessage, markDelivered };
