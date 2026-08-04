// worker.js — Nextup/Scenera background import worker
//
// Runs as its OWN Render service, completely separate from server.js.
// It shares nothing at runtime with the web server except the same
// Postgres database (via DATABASE_URL, for the pg-boss queue itself)
// and the same Supabase project (for reading/writing shows/watchlist
// data and downloading uploaded files from Storage).
//
// Why a separate process instead of just running this inside
// server.js on a timer: Node is single-threaded. If a heavy,
// synchronous-feeling chunk of import work (parsing a huge CSV,
// looping through TMDB matches) ran inside the same process as the
// web server, it could still noticeably slow down every other
// request arriving at the same moment — not a full crash, but a real
// stall for every other user. Keeping the worker in its own process
// means the web server stays fully responsive no matter how heavy
// (or how many, one after another) the imports being processed are.
require("./instrument.js"); // Sentry — must load before anything else
const Sentry = require("@sentry/node");
const { createClient } = require("@supabase/supabase-js");
const { getBoss, IMPORT_QUEUE } = require("./queue");
const { extractZipFiles, runImportJob } = require("./importProcessor");

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection in worker:", reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Downloads whatever the route handler uploaded to Supabase Storage
// for this job and reconstructs the same `files` shape that
// runImportJob (and, before it, the old inline processImport)
// expects — { "filename.csv": "raw csv text", ... }.
async function loadFilesForJob({ jobId, kind, fields }) {
  if (kind === "zip") {
    const { data, error } = await supabase.storage
      .from("import-uploads")
      .download(`imports/${jobId}/export.zip`);
    if (error) throw error;
    const buffer = Buffer.from(await data.arrayBuffer());
    return extractZipFiles(buffer); // throws a clear error if a required file is missing
  }

  // kind === "csv" — one object per selected field, uploaded
  // individually by the /import/tvtime route.
  const files = {};
  for (const field of fields) {
    const { data, error } = await supabase.storage
      .from("import-uploads")
      .download(`imports/${jobId}/${field}.csv`);
    if (error) throw error;
    const buffer = Buffer.from(await data.arrayBuffer());
    files[`${field}.csv`] = buffer.toString("utf8");
  }
  return files;
}

async function handleImportJob(job) {
  const { jobId, userId, kind, fields } = job.data;
  console.log(`Processing import job ${jobId} (kind=${kind})`);

  try {
    const files = await loadFilesForJob({ jobId, kind, fields });
    const result = await runImportJob(supabase, { jobId, userId, files });
    console.log(`Import job ${jobId} done:`, result);
  } catch (err) {
    console.error(`Import job ${jobId} failed:`, err.message);
    Sentry.captureException(err);
    // Mirrors the schema's existing 'failed' status and `error`
    // column — the client's existing GET /import/status/:jobId
    // polling already reads both, no frontend change needed to
    // surface this.
    await supabase
      .from("import_jobs")
      .update({ status: "failed", error: err.message, completed_at: new Date().toISOString() })
      .eq("id", jobId);
  } finally {
    // Best-effort cleanup — the uploaded file's only purpose was to
    // survive the trip from the web request to this worker. Leaving
    // it behind costs Storage space for no benefit, but a failed
    // cleanup here should never fail the job itself.
    try {
      if (kind === "zip") {
        await supabase.storage.from("import-uploads").remove([`imports/${jobId}/export.zip`]);
      } else {
        await supabase.storage.from("import-uploads").remove(fields.map((f) => `imports/${jobId}/${f}.csv`));
      }
    } catch (cleanupErr) {
      console.error(`Cleanup failed for job ${jobId} (non-fatal):`, cleanupErr.message);
    }
  }
}

async function main() {
  const boss = await getBoss();
  // Processes one import job at a time (default concurrency) — this
  // is deliberate, not a limitation to work around later. One job at
  // a time keeps TMDB request volume predictable and matches the
  // free-tier resources this runs on; if imports ever back up
  // noticeably in practice, that's a signal to look at concurrency
  // then, with real data instead of a guess.
  await boss.work(IMPORT_QUEUE, handleImportJob);
  console.log("Import worker started, listening for jobs.");
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  Sentry.captureException(err);
  process.exit(1);
});
