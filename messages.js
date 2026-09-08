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

  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("*")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: true });
  if (msgError) throw msgError;

  return messages || [];
}

module.exports = { sendMessage, getMessages };
