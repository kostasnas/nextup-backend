// importProcessor.js
// The actual (slow) work of turning an uploaded TV Time export into
// shows/watchlist rows — pulled out of server.js so it can run inside
// worker.js, one job at a time, instead of running inline inside an
// HTTP request. That used to mean several people uploading at once
// could all slow down (or in a bad case, overload) the same process
// that's also trying to serve everyone else's ordinary requests.
const AdmZip = require("adm-zip");
const { parseGdprExport } = require("./importParser");
const { matchShows } = require("./tmdbMatcher");

const REQUIRED_FILES = ["user_tv_show_data.csv", "show_seen_episode_latest.csv", "followed_tv_show.csv", "tv_show_rate.csv"];
const OPTIONAL_FILES = ["seen_episode_source.csv", "episode_emotion.csv", "tracking-prod-records-v2.csv"];

// Previously this validation ran synchronously in the route handler,
// so a malformed zip failed instantly with a 400. Now the upload is
// accepted first and unzipped later in the worker, so a bad zip
// instead surfaces as a "failed" job (with this message in the
// job's `error` column) that the client sees via the existing
// GET /import/status/:jobId polling — same information, just
// delivered asynchronously instead of in the original response.
function extractZipFiles(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const files = {};

  for (const needed of REQUIRED_FILES) {
    const entry = entries.find((e) => e.entryName.toLowerCase().endsWith(needed));
    if (!entry) {
      throw new Error(`Could not find ${needed} inside the uploaded zip. Make sure the full TV Time GDPR export was uploaded.`);
    }
    files[needed] = entry.getData().toString("utf8");
  }
  for (const optional of OPTIONAL_FILES) {
    const entry = entries.find((e) => e.entryName.toLowerCase().endsWith(optional));
    if (entry) files[optional] = entry.getData().toString("utf8");
  }
  return files;
}

async function upsertShowProgress(supabase, userId, show, jobId, extras = {}) {
  const tmdbId = show.match.tmdbId;

  const { data: existingShow } = await supabase.from("shows").select("id, poster_path").eq("tmdb_id", tmdbId).single();

  let showRowId;
  if (existingShow) {
    showRowId = existingShow.id;
    if (show.match.posterPath && !existingShow.poster_path) {
      await supabase.from("shows").update({ poster_path: show.match.posterPath }).eq("id", showRowId);
    }
  } else {
    const { data: newShow, error } = await supabase
      .from("shows")
      .insert({ tmdb_id: tmdbId, title: show.title, poster_path: show.match.posterPath || null })
      .select()
      .single();
    if (error) throw error;
    showRowId = newShow.id;
  }

  await supabase.from("user_watchlist").upsert(
    {
      user_id: userId,
      show_id: showRowId,
      status: show.isArchived ? "dropped" : show.episodesSeenCount > 0 ? "watching" : "planned",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,show_id" }
  );

  if (jobId) {
    await supabase.from("import_job_shows").insert({
      import_job_id: jobId,
      show_id: showRowId,
      tmdb_id: tmdbId,
      episodes_seen_count: show.episodesSeenCount || 0,
      episode_log: extras.episodeLog || null,
      emotion_log: extras.emotionLog || null,
    });
  }
}

/**
 * Runs the import for a job that already exists (created up front by
 * the route handler, status "queued", before any TMDB work has
 * happened). Parses the files, matches every show against TMDB,
 * writes shows/watchlist rows, and updates the job's own status and
 * counts when done. This is exactly the work that used to happen
 * inline inside the HTTP request.
 */
async function runImportJob(supabase, { jobId, userId, files }) {
  await supabase.from("import_jobs").update({ status: "matching" }).eq("id", jobId);

  const { shows, episodeLogByShow, emotionLogByShow, stats } = parseGdprExport(files);
  const matched = await matchShows(shows);

  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const show of matched) {
    if (show.match.status === "matched") {
      matchedCount++;
      await upsertShowProgress(supabase, userId, show, jobId, {
        episodeLog: episodeLogByShow[show.title] || null,
        emotionLog: emotionLogByShow[show.title] || null,
      });
    } else {
      unmatchedCount++;
      await supabase.from("import_unmatched").insert({
        import_job_id: jobId,
        raw_title: show.title,
        candidate_tmdb_ids: show.match.candidates.map((c) => c.id),
      });
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: unmatchedCount > 0 ? "needs_review" : "completed",
      matched_records: matchedCount,
      unmatched_records: unmatchedCount,
      total_records: stats.totalShows,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  return { matchedCount, unmatchedCount, totalShows: stats.totalShows };
}

module.exports = { extractZipFiles, runImportJob, REQUIRED_FILES, OPTIONAL_FILES };
