// commsStore.js
// Our own data for the CommsUni integration: each user's identity choice, the
// authors they've blocked (CommsUni has no block-list endpoint, so blocking is
// ours), suspensions, and a log of what we've written upstream (used for
// moderation clean-up without ever scraping the API). Tables are created on
// first use, so there is no manual migration step.
const { getPool } = require("./db");

let ready = null;
function ensureTables() {
  if (!ready) {
    ready = getPool().query(`
      create table if not exists comms_profiles (
        user_id uuid primary key,
        share_identity boolean not null,
        synced_hash text,
        author_id text,
        updated_at timestamptz not null default now()
      );
      create table if not exists comms_blocks (
        user_id uuid not null,
        author_id text not null,
        author_name text,
        created_at timestamptz not null default now(),
        primary key (user_id, author_id)
      );
      create table if not exists comms_suspensions (
        user_id uuid primary key,
        reason text,
        created_at timestamptz not null default now()
      );
      create table if not exists comms_write_log (
        id bigserial primary key,
        user_id uuid not null,
        kind text not null,
        comment_id text,
        body text,
        created_at timestamptz not null default now()
      );
      alter table comms_profiles enable row level security;
      alter table comms_blocks enable row level security;
      alter table comms_suspensions enable row level security;
      alter table comms_write_log enable row level security;
    `).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function getProfile(userId) {
  await ensureTables();
  const { rows } = await getPool().query("select * from comms_profiles where user_id = $1", [userId]);
  return rows[0] || null;
}

async function setProfile(userId, fields) {
  await ensureTables();
  const cur = (await getProfile(userId)) || {};
  const next = { share_identity: cur.share_identity, synced_hash: cur.synced_hash ?? null, author_id: cur.author_id ?? null, ...fields };
  await getPool().query(
    `insert into comms_profiles (user_id, share_identity, synced_hash, author_id, updated_at)
     values ($1,$2,$3,$4, now())
     on conflict (user_id) do update set share_identity = excluded.share_identity,
       synced_hash = excluded.synced_hash, author_id = excluded.author_id, updated_at = now()`,
    [userId, next.share_identity, next.synced_hash, next.author_id]
  );
}

async function blockedAuthorIds(userId) {
  try {
    await ensureTables();
    const { rows } = await getPool().query("select author_id from comms_blocks where user_id = $1", [userId]);
    return new Set(rows.map((r) => r.author_id));
  } catch (e) {
    console.error("comms blocks lookup failed:", e.message);
    return new Set();
  }
}

async function listBlocks(userId) {
  await ensureTables();
  const { rows } = await getPool().query(
    "select author_id, author_name, created_at from comms_blocks where user_id = $1 order by created_at desc", [userId]);
  return rows;
}

async function addBlock(userId, authorId, authorName) {
  await ensureTables();
  await getPool().query(
    `insert into comms_blocks (user_id, author_id, author_name) values ($1,$2,$3)
     on conflict (user_id, author_id) do update set author_name = excluded.author_name`,
    [userId, authorId, authorName ? String(authorName).slice(0, 80) : null]);
}

async function removeBlock(userId, authorId) {
  await ensureTables();
  await getPool().query("delete from comms_blocks where user_id = $1 and author_id = $2", [userId, authorId]);
}

async function isSuspended(userId) {
  try {
    await ensureTables();
    const { rows } = await getPool().query("select 1 from comms_suspensions where user_id = $1", [userId]);
    return rows.length > 0;
  } catch (e) {
    console.error("comms suspension lookup failed:", e.message);
    return false;
  }
}

async function logWrite(userId, kind, commentId, body) {
  try {
    await ensureTables();
    await getPool().query(
      "insert into comms_write_log (user_id, kind, comment_id, body) values ($1,$2,$3,$4)",
      [userId, kind, commentId || null, body ? String(body).slice(0, 2000) : null]);
  } catch (e) {
    console.error("comms write log failed:", e.message);
  }
}

module.exports = { ensureTables, getProfile, setProfile, blockedAuthorIds, listBlocks, addBlock, removeBlock, isSuspended, logWrite };
