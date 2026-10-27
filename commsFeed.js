// commsFeed.js
// Poller for the CommsUni notification feed (GET /v1/feed/notifications): replies to and likes on our
// users' Community comments, from any app. One poll for the whole key, then the events are fanned out
// into the in-app inbox (notifications.js). In-app only, never a push, like the Scenera comment likes.
// Mentions and visibility events are deliberately ignored for now.
//
// Follows partner-feeds-guide: send the stored `since`, follow `nextCursor` (with the same `since`) until
// `complete`, and store `nextSince` only from that last page. Events repeat between polls, so every event id
// is remembered in comms_feed_seen. The tables are created on first use (same as commsStore.js).
const { getPool } = require("./db");
const { isConfigured, commsRequest } = require("./commsuni");
const { createNotification } = require("./notifications");

const FEED = "notifications";
const PATH = "/feed/notifications";
const MAX_PAGES = 40; // safety net for one run; the next run continues from the same `since`
const MIN_GAP_MS = 31 * 1000; // the API refuses a cursor-less poll within 30 s of the last one
const SEEN_KEEP_DAYS = 4;

let ready = null;
function ensureTables(pool) {
  if (!ready) {
    ready = pool.query(`
      create table if not exists comms_feed_state (
        feed text primary key,
        since text,
        updated_at timestamptz not null default now()
      );
      create table if not exists comms_feed_seen (
        event_id text primary key,
        seen_at timestamptz not null default now()
      );
      alter table comms_feed_state enable row level security;
      alter table comms_feed_seen enable row level security;
    `).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let running = false;
let lastStartedAt = 0;

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Turns one feed event into the inbox row, or null when nothing should be shown.
function render(event) {
  if (event.kind !== "reply" && event.kind !== "like") return null;
  const c = event.comment;
  if (event.kind === "reply" && (!c || c.deleted)) return null; // the reply is gone
  if (event.kind === "like" && !c) return null; // our user's own comment is no longer visible
  const who = clip(event.actor?.userName, 40) || "Someone";
  const e = c.entity || {};
  const where = [e.showTitle, e.title].filter(Boolean).join(" · ");
  const quote = c.text && !c.deleted ? `“${clip(c.text, 80)}”` : "";
  if (event.kind === "reply") {
    return {
      type: "comms_reply",
      title: `${who} replied to your comment`,
      body: [where && `On ${where}`, quote].filter(Boolean).join("\n"),
    };
  }
  return {
    type: "comms_like",
    title: `${who} liked your comment`,
    body: where ? `On ${where}` : "In the Community",
  };
}

/**
 * One full traversal. Dependencies can be injected for tests.
 * Returns { status, events, notified } where status is one of
 * ok | not_configured | busy | too_soon | feed_unavailable | rate_limited | error.
 */
async function pollNotifications(supabase, deps = {}) {
  const pool = deps.pool || getPool();
  const request = deps.request || commsRequest;
  const notify = deps.notify || createNotification;
  const now = deps.now || Date.now;

  if (!(deps.configured ?? isConfigured())) return { status: "not_configured" };
  if (running) return { status: "busy" };
  if (now() - lastStartedAt < MIN_GAP_MS) return { status: "too_soon" };
  running = true;
  lastStartedAt = now();
  try {
    await ensureTables(pool);
    const st = await pool.query("select since from comms_feed_state where feed = $1", [FEED]);
    let since = st.rows[0]?.since || null;

    let cursor = null;
    let pages = 0;
    let events = 0;
    let notified = 0;
    let failed = false;

    for (;;) {
      if (++pages > MAX_PAGES) return { status: "ok", events, notified, partial: true };
      const params = new URLSearchParams({ limit: "100" });
      if (since) params.set("since", since);
      if (cursor) params.set("cursor", cursor);
      const res = await request(`${PATH}?${params.toString()}`);

      if (res.status === 503 && res.error?.code === "feed_unavailable") return { status: "feed_unavailable" };
      if (res.status === 429) return { status: "rate_limited" };
      if (res.status === 400 && res.error?.code === "invalid_cursor") { cursor = null; continue; }
      if (res.status === 400 && res.error?.code === "invalid_parameter" && since) { since = null; cursor = null; continue; }
      if (!res.ok || !res.data) {
        console.error("comms feed poll failed:", res.status, res.error?.code || "", res.error?.message || "");
        return { status: "error", httpStatus: res.status };
      }

      const list = Array.isArray(res.data.events) ? res.data.events : [];
      events += list.length;
      const wanted = list.filter((ev) => ev && ev.id && (ev.kind === "reply" || ev.kind === "like") && ev.recipientAuthorId);
      if (wanted.length) {
        const ids = wanted.map((ev) => String(ev.id));
        const seen = new Set((await pool.query("select event_id from comms_feed_seen where event_id = any($1)", [ids])).rows.map((r) => r.event_id));
        const fresh = wanted.filter((ev) => !seen.has(String(ev.id)));
        if (fresh.length) {
          const authorIds = [...new Set([
            ...fresh.map((ev) => String(ev.recipientAuthorId)),
            ...fresh.map((ev) => ev.actor?.id).filter(Boolean).map(String),
          ])];
          const owners = new Map((await pool.query("select user_id, author_id from comms_profiles where author_id = any($1)", [authorIds])).rows.map((r) => [r.author_id, r.user_id]));
          for (const ev of fresh) {
            try {
              const userId = owners.get(String(ev.recipientAuthorId));
              // Not ours, or done by one of our own users (our app already handles that side).
              const skip = !userId || (ev.actor?.id && owners.has(String(ev.actor.id)));
              const row = skip ? null : render(ev);
              if (row) {
                await notify(supabase, userId, {
                  type: row.type, title: row.title, body: row.body,
                  data: { source: "commsuni", eventId: String(ev.id), commentId: ev.commentId || null, entity: ev.comment?.entity || null },
                });
                notified++;
              }
              await pool.query("insert into comms_feed_seen (event_id) values ($1) on conflict do nothing", [String(ev.id)]);
            } catch (e) {
              failed = true; // not marked as seen, and `since` stays where it is, so the next run retries it
              console.error("comms feed event failed:", ev.id, e.message);
            }
          }
        }
      }

      if (res.data.complete) {
        if (!failed && res.data.nextSince) {
          await pool.query(
            `insert into comms_feed_state (feed, since, updated_at) values ($1,$2, now())
             on conflict (feed) do update set since = excluded.since, updated_at = now()`,
            [FEED, res.data.nextSince]
          );
        }
        await pool.query(`delete from comms_feed_seen where seen_at < now() - interval '${SEEN_KEEP_DAYS} days'`).catch(() => {});
        return { status: "ok", events, notified, advanced: !failed };
      }
      cursor = res.data.nextCursor;
      if (!cursor) return { status: "error", reason: "incomplete page without nextCursor" };
    }
  } catch (e) {
    console.error("comms feed poll crashed:", e.message);
    return { status: "error", reason: e.message };
  } finally {
    running = false;
  }
}

module.exports = { pollNotifications, render };
