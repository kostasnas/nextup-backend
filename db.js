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
  const [{ rows: eps }, { rows: movies }, { rows: jobs }] = await Promise.all([
    epsP,
    pool.query(
      `select coalesce(m.runtime, 0) as runtime, nullif(left(m.release_date::text, 4), '')::int as year from user_movie_watchlist w
         join movies m on m.id = w.movie_id where w.user_id = $1 and w.status = 'watched'`, [userId]),
    pool.query(`select min(created_at) as first_import from import_jobs where user_id = $1`, [userId]),
  ]);
  return { eps, movies, firstImport: jobs[0]?.first_import || null };
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
  getSignupRank, getPool, findUserByEmail, findUserByUsername, getUserDisplayInfo, getUsersCreatedSince };
