// db.js
// Direct Postgres connection (same DATABASE_URL already used by
// pg-boss) — used for the handful of things the regular Supabase
// client can't do at all, like looking up a user by email in
// auth.users. That table isn't exposed through Supabase's normal
// REST client (by design — it's how the SQL editor queries we ran
// manually all day worked, not through supabase-js), so a real
// Postgres connection is the only way to do it from code.
const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — needed for direct auth.users lookups.");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

// Signup order (1 = first account) among accounts that exist today, by auth.users.created_at.
async function getSignupRank(userId) {
  const { rows } = await getPool().query(
    "select (select count(*) from auth.users u where u.created_at <= me.created_at)::int as rank, me.created_at from auth.users me where me.id = $1",
    [userId]
  );
  return rows[0] || null;
}

// Early-account ticket number that stays put. getSignupRank() counts accounts that exist
// TODAY, so deleting an earlier account used to shift everyone after it down by one.
// The number is now written once, to auth.users.raw_user_meta_data.pioneer_number.
// The first time anyone asks, every account that has no number yet (up to the 1,000
// ticket cap) gets the next free one in signup order, under a lock so two requests can't
// hand out the same number. Returns { number, created_at }, or { number: null } when the
// account is past the cap.
async function getPioneerNumber(userId) {
  const pool = getPool();
  const read = async (q) => (await q.query(
    "select (raw_user_meta_data->>'pioneer_number')::int as number, created_at from auth.users where id = $1",
    [userId]
  )).rows[0] || null;
  let me = await read(pool);
  if (!me || me.number != null) return me;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(7340211)");
    me = await read(client); // another request may have assigned it meanwhile
    if (me && me.number == null) {
      await client.query(
        `with base as (select coalesce(max((raw_user_meta_data->>'pioneer_number')::int), 0) as b from auth.users),
              todo as (select id, row_number() over (order by created_at, id) as rn
                         from auth.users where raw_user_meta_data->>'pioneer_number' is null)
         update auth.users u
            set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
                                     || jsonb_build_object('pioneer_number', base.b + todo.rn)
           from todo, base
          where u.id = todo.id and base.b + todo.rn <= 1000`
      );
      me = await read(client);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return me;
}

// Everything the Stats screen needs about a user's watching, in one pass.
// Imported rows (source starting "import") whose watched_at is at/after the
// user's first import job are treated as UNDATED: importers stamp "now" on
// episodes that had no date in the source file, so those timestamps are the
// import day, not the day it was watched.
async function getStatsRows(userId) {
  const pool = getPool();
  const epSql = (cols) => `select we.watched_at, we.source, e.show_id, s.title, s.poster_path, s.network, ${cols}
              coalesce(s.avg_episode_runtime, 42) as rt
         from watched_episodes we
         join episodes e on e.id = we.episode_id
         join shows s on s.id = e.show_id
        where we.user_id = $1`;
  // Before the genres migration has run, fall back to the plain query.
  const epsP = pool.query(epSql("s.genres, s.first_air_year,"), [userId])
    .catch((e) => { if (e.code === "42703") return pool.query(epSql(""), [userId]); throw e; });
  const [{ rows: eps }, { rows: movies }, { rows: jobs }, { rows: reactions }] = await Promise.all([
    epsP,
    pool.query(
      `select coalesce(m.runtime, 0) as runtime, nullif(left(m.release_date::text, 4), '')::int as year from user_movie_watchlist w
         join movies m on m.id = w.movie_id where w.user_id = $1 and w.status = 'watched'`, [userId]),
    pool.query(`select min(created_at) as first_import from import_jobs where user_id = $1`, [userId]),
    pool.query(`select reaction, count(*)::int as count from watched_episodes where user_id = $1 and reaction is not null group by reaction`, [userId]),
  ]);
  return { eps, movies, reactions, firstImport: jobs[0]?.first_import || null };
}

async function findUserByEmail(email) {
  const { rows } = await getPool().query(
    "select id, email from auth.users where lower(email) = lower($1) limit 1",
    [email]
  );
  return rows[0] || null;
}

async function findUserByUsername(username) {
  const { rows } = await getPool().query(
    `select au.id, au.email
     from user_profiles up
     join auth.users au on au.id = up.user_id
     where lower(up.username) = lower($1)
     limit 1`,
    [username]
  );
  return rows[0] || null;
}

async function getUserDisplayInfo(userId) {
  const { rows } = await getPool().query(
    `select id, email,
            raw_user_meta_data->>'display_name' as display_name,
            raw_user_meta_data->>'avatar_url' as avatar_url
     from auth.users where id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// Used for one-off "welcome" push sends (see welcomeMessages.js) —
// everyone who signed up in the last N days. email_confirmed_at is
// checked so we don't message someone who abandoned signup before
// confirming their account.
async function getUsersCreatedSince(days) {
  const { rows } = await getPool().query(
    `select id, email, raw_user_meta_data->>'display_name' as display_name
     from auth.users
     where created_at >= now() - ($1 || ' days')::interval
       and email_confirmed_at is not null`,
    [days]
  );
  return rows;
}

module.exports = {
  getStatsRows,
  getSignupRank, getPioneerNumber, getPool, findUserByEmail, findUserByUsername, getUserDisplayInfo, getUsersCreatedSince };
