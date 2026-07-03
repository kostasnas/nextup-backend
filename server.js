// server.js — Nextup backend
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { parseGdprExport } = require("./importParser");
const { matchShows } = require("./tmdbMatcher");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "nextup-backend" });
});

// Accepts the 4 CSV files from a TV Time GDPR export, matches shows
// against TMDB, and stores results as an import_job the frontend can poll.
app.post(
  "/import/tvtime",
  upload.fields([
    { name: "user_tv_show_data", maxCount: 1 },
    { name: "show_seen_episode_latest", maxCount: 1 },
    { name: "followed_tv_show", maxCount: 1 },
    { name: "tv_show_rate", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const userId = req.body.user_id;
      if (!userId) return res.status(400).json({ error: "user_id is required" });

      const files = {};
      for (const [field, arr] of Object.entries(req.files)) {
        files[`${field}.csv`] = arr[0].buffer.toString("utf8");
      }

      const { shows, stats } = parseGdprExport(files);

      const { data: job, error: jobError } = await supabase
        .from("import_jobs")
        .insert({ user_id: userId, source: "tvtime", status: "matching", total_records: stats.totalShows })
        .select()
        .single();
      if (jobError) throw jobError;

      // Matching happens synchronously here for simplicity. For 300+ shows
      // this can take a couple of minutes (rate-limited TMDB calls) — if
      // that proves too slow in practice, move this to a background job
      // and have the frontend poll /import/status/:jobId instead.
      const matched = await matchShows(shows);

      let matchedCount = 0;
      let unmatchedCount = 0;

      for (const show of matched) {
        if (show.match.status === "matched") {
          matchedCount++;
          await upsertShowProgress(userId, show);
        } else {
          unmatchedCount++;
          await supabase.from("import_unmatched").insert({
            import_job_id: job.id,
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
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      res.json({ jobId: job.id, matchedCount, unmatchedCount, totalShows: stats.totalShows });
    } catch (err) {
      console.error("Import failed:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

async function upsertShowProgress(userId, show) {
  const tmdbId = show.match.tmdbId;

  let { data: existingShow } = await supabase.from("shows").select("id").eq("tmdb_id", tmdbId).single();

  let showRowId = existingShow?.id;
  if (!showRowId) {
    const { data: newShow, error } = await supabase
      .from("shows")
      .insert({ tmdb_id: tmdbId, title: show.title })
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
    },
    { onConflict: "user_id,show_id" }
  );

  // Episode-level marking (up to episodesSeenCount) happens once the
  // show's full episode list has been fetched from TMDB and cached
  // in the `episodes` table — left as a follow-up call, not inline
  // here, to keep this endpoint from timing out on large libraries.
}

// Lets the frontend show progress while a large import is running.
app.get("/import/status/:jobId", async (req, res) => {
  const { data, error } = await supabase.from("import_jobs").select("*").eq("id", req.params.jobId).single();
  if (error) return res.status(404).json({ error: "Job not found" });
  res.json(data);
});

// Returns unmatched shows for the manual-review UI, with candidate options.
app.get("/import/:jobId/unmatched", async (req, res) => {
  const { data, error } = await supabase.from("import_unmatched").select("*").eq("import_job_id", req.params.jobId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// User picks the correct show from candidates (or "none of these").
app.post("/import/unmatched/:rowId/resolve", async (req, res) => {
  const { tmdbId, userId } = req.body;
  const { data: row, error } = await supabase
    .from("import_unmatched")
    .update({ resolved_tmdb_id: tmdbId, resolved: true })
    .eq("id", req.params.rowId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await upsertShowProgress(userId, { title: row.raw_title, match: { tmdbId }, episodesSeenCount: 0, isArchived: false });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nextup backend running on port ${PORT}`));
