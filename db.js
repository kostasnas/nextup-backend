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

async function findUserByEmail(email) {
  const { rows } = await getPool().query(
    "select id, email from auth.users where lower(email) = lower($1) limit 1",
    [email]
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

module.exports = { getPool, findUserByEmail, getUserDisplayInfo };
