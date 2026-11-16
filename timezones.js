// timezones.js
// Turns the time zone a person's phone reported (user_metadata.acquisition.tz) into one Postgres accepts,
// falling back to UTC. Looking a name up in pg_timezone_names is SLOW (the database rebuilds the whole
// list on every call; on the small Supabase instance it cost seconds and was the biggest single load on
// the database), so each distinct name is checked once and remembered for the life of the process.
const { getPool } = require("./db");

const known = new Map(); // reported name -> name to use
const MAX_REMEMBERED = 500; // the value comes from the client: never let this grow without limit

async function resolveTimeZone(reported) {
  if (typeof reported !== "string" || !reported.trim() || reported.length > 64) return "UTC";
  if (known.has(reported)) return known.get(reported);
  try {
    const { rows } = await getPool().query("select name from pg_timezone_names where name = $1 limit 1", [reported]);
    const tz = rows[0]?.name || "UTC";
    if (known.size < MAX_REMEMBERED) known.set(reported, tz);
    return tz;
  } catch (e) {
    console.error("time zone lookup failed:", e.message);
    return "UTC"; // not remembered: try again next time
  }
}

module.exports = { resolveTimeZone };
