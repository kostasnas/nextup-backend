// queue.js
// Shared pg-boss instance — the job queue that lets an import upload
// get accepted instantly (server.js) and actually processed later,
// one job at a time, by a completely separate process (worker.js).
// pg-boss stores the queue inside our own Postgres database, so
// there's no extra infrastructure (like Redis) to run, monitor, or
// pay for — just the DATABASE_URL connection string.
const PgBoss = require("pg-boss");

let bossPromise = null;

// Both server.js and worker.js call this — the actual PgBoss client
// (and its own internal tables) only gets created and started once,
// the first time either process asks for it.
function getBoss() {
  if (!bossPromise) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — pg-boss needs a direct Postgres connection string, not the Supabase REST credentials.");
    }
    const boss = new PgBoss(process.env.DATABASE_URL);
    boss.on("error", (err) => console.error("pg-boss error:", err));
    bossPromise = boss.start().then(() => boss);
  }
  return bossPromise;
}

const IMPORT_QUEUE = "process-import";

module.exports = { getBoss, IMPORT_QUEUE };
