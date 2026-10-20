// importAlert.js
// Tells the developer (push) when an import left a noticeable number of titles behind, so the
// cause can be found and fixed without waiting for the person to write. Fire-and-forget: it never
// delays or breaks the import response.
//
// Rule: alert when at least IMPORT_ALERT_MIN titles (shows + movies) did not match (default 5 — a
// couple of misses is easy to add by hand), or when nothing matched at all. At most one alert per
// person and source per hour, so repeated retries (e.g. five uploads in a row) don't flood.
const MIN_UNMATCHED = Math.max(1, parseInt(process.env.IMPORT_ALERT_MIN || "5", 10) || 5);
const COOLDOWN_MS = 60 * 60 * 1000;
const lastAlert = new Map(); // `${userId}:${source}` -> timestamp

function summarize(result) {
  const totalShows = Number(result?.totalShows) || 0;
  const totalMovies = Number(result?.totalMovies) || 0;
  const matchedShows = Number(result?.matchedCount) || 0;
  const matchedMovies = Number(result?.movieMatchedCount) || 0;
  const total = totalShows + totalMovies;
  const matched = matchedShows + matchedMovies;
  const unmatched = Math.max(0, totalShows - matchedShows) + Math.max(0, totalMovies - matchedMovies);
  return { total, matched, unmatched };
}

function shouldAlert({ total, matched, unmatched }) {
  return total > 0 && (matched === 0 || unmatched >= MIN_UNMATCHED);
}

// Keeps the titles of movies that didn't come over (the import itself only counts them), so the
// cause can be looked at later. Needs the table from migrations/import_unmatched_movies.sql; until
// it exists the insert just fails quietly.
async function saveUnmatchedMovies(supabase, jobId, list) {
  if (!jobId || !Array.isArray(list) || !list.length) return;
  const rows = list.slice(0, 1000).map((m) => ({ import_job_id: jobId, raw_title: String(m.title || "").slice(0, 300), raw_year: Number.isInteger(m.year) ? m.year : null }));
  const { error } = await supabase.from("import_unmatched_movies").insert(rows);
  if (error) console.error("Saving unmatched movies failed (is the import_unmatched_movies table created?):", error.message);
}

function reportImportIssue(supabase, sendPushToUser, userId, source, result) {
  try {
    saveUnmatchedMovies(supabase, result?.jobId, result?.unmatchedMovies).catch((e) => console.error("Saving unmatched movies failed:", e.message));
    const s = summarize(result);
    if (!shouldAlert(s)) return;
    const adminId = process.env.ADMIN_USER_ID || "47d65eeb-e49b-4854-a5e4-64b468541886";
    if (userId === adminId) return; // your own test imports
    const key = `${userId}:${source}`;
    const now = Date.now();
    if (now - (lastAlert.get(key) || 0) < COOLDOWN_MS) return;
    lastAlert.set(key, now);
    const body = `${source}: ${s.unmatched} of ${s.total} didn't match (${s.matched} did). User ${String(userId).slice(0, 8)}, job ${String(result?.jobId || "?").slice(0, 8)}`;
    Promise.resolve(sendPushToUser(supabase, adminId, { title: "Import issue", body: body.slice(0, 160) }))
      .catch((e) => console.error("Import alert push failed:", e.message));
  } catch (e) {
    console.error("Import alert failed:", e.message);
  }
}

module.exports = { reportImportIssue, summarize, shouldAlert };
