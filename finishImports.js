// finishImports.js
// Finishes imports whose second step (fetching each show's episodes and writing the watch history)
// never ran to the end, without the person having to open the app: the app used to be the only thing
// that ran that step, so closing it during an import left the history unwritten.
//
// Run by the developer, same way as the other one-off admin calls (paste the URL into a browser):
//   /admin/finish-imports?secret=<CRON_SECRET>&go=1                  start: all unfinished imports
//   /admin/finish-imports?secret=<CRON_SECRET>&go=1&user=<user id>   start: one person's
//   /admin/finish-imports?secret=<CRON_SECRET>                       progress only (never starts anything)
//   /admin/finish-imports?secret=<CRON_SECRET>&stop=1                stop after the current group of shows
// Starting answers at once and the work goes on in the background; open the progress URL to follow it.
// Safe to repeat: finished shows are marked, and the app's own resume (importResume.js) and this
// can overlap without harm. Shows that fail are skipped for the rest of the run and reported.
const { getPool } = require("./db");

const BATCH = 24;
const CONCURRENCY = 4;
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function mountFinishImports(app, { supabase, asyncHandler, syncShowProgress, forEachConcurrent }) {
  const state = { running: false, stopRequested: false, user: null, startedAt: null, finishedAt: null, done: 0, failed: [], lastError: null };

  async function countRemaining(userId) {
    const { rows } = await getPool().query(
      `select count(*)::int as n from import_job_shows s join import_jobs j on j.id = s.import_job_id
        where s.synced = false and ($1::uuid is null or j.user_id = $1::uuid)`,
      [userId]
    );
    return rows[0].n;
  }

  async function run(userId) {
    const failedIds = [];
    try {
      for (;;) {
        if (state.stopRequested) break;
        const { rows } = await getPool().query(
          `select s.id, s.show_id, s.tmdb_id, s.episodes_seen_count, s.episode_log, s.emotion_log, j.user_id
             from import_job_shows s join import_jobs j on j.id = s.import_job_id
            where s.synced = false and ($1::uuid is null or j.user_id = $1::uuid) and s.id <> all($2::uuid[])
            order by j.created_at, s.id
            limit ${BATCH}`,
          [userId, failedIds]
        );
        if (rows.length === 0) break;
        await forEachConcurrent(rows, CONCURRENCY, async (row) => {
          try {
            await syncShowProgress(supabase, {
              userId: row.user_id,
              showRowId: row.show_id,
              tmdbId: row.tmdb_id,
              episodesSeenCount: row.episodes_seen_count,
              episodeLog: row.episode_log,
              emotionLog: row.emotion_log,
            });
            await getPool().query("update import_job_shows set synced = true where id = $1", [row.id]);
            state.done++;
          } catch (err) {
            failedIds.push(row.id);
            if (state.failed.length < 50) state.failed.push({ tmdbId: row.tmdb_id, error: String(err?.message || err).slice(0, 160) });
            console.error(`finish-imports: tmdb_id ${row.tmdb_id} failed:`, err?.message || err);
          }
        });
      }
    } catch (err) {
      state.lastError = String(err?.message || err);
      console.error("finish-imports stopped:", err);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }

  const handler = asyncHandler(async (req, res) => {
    const provided = req.headers["x-cron-secret"] || req.query.secret;
    if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.query.user ? String(req.query.user) : null;
    if (userId && !isUuid(userId)) return res.status(400).json({ error: "user must be a user id" });

    if (req.query.stop) {
      state.stopRequested = true;
      return res.json({ ok: true, message: "Will stop after the current group of shows.", running: state.running });
    }

    let started = false;
    if (req.query.go && !state.running) {
      Object.assign(state, { running: true, stopRequested: false, user: userId, startedAt: new Date().toISOString(), finishedAt: null, done: 0, failed: [], lastError: null });
      started = true;
      run(userId); // deliberately not awaited: this answers straight away and the work goes on
    }
    res.json({
      started,
      running: state.running,
      remaining: await countRemaining(state.running ? state.user : userId),
      hint: state.running || started ? undefined : "Add &go=1 to start.",
      doneThisRun: state.done,
      failedThisRun: state.failed.length,
      failures: state.failed.slice(0, 10),
      lastError: state.lastError,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    });
  });
  app.get("/admin/finish-imports", handler);
  app.post("/admin/finish-imports", handler);
}

module.exports = { mountFinishImports };
