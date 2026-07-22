// server.js — Nextup/Scenera backend
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { createClient } = require("@supabase/supabase-js");
const { parseGdprExport } = require("./importParser");
const { matchShows } = require("./tmdbMatcher");
const { syncShowProgress } = require("./episodeSync");

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

// Shared by both import routes (individual files or a whole zip) —
// takes the 4 CSV contents as strings, matches against TMDB, and
// records everything the same way either route got here.
async function processImport(userId, files) {
  const { shows, stats } = parseGdprExport(files);
  const watchingCandidates = shows.filter((s) => s.episodesSeenCount > 0).length;
  console.log(`Parsed ${shows.length} shows, ${watchingCandidates} have episodesSeenCount > 0. Sample:`, shows.slice(0, 3));

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "tvtime", status: "matching", total_records: stats.totalShows })
    .select()
    .single();
  if (jobError) throw jobError;

  const matched = await matchShows(shows);

  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const show of matched) {
    if (show.match.status === "matched") {
      matchedCount++;
      await upsertShowProgress(userId, show, job.id);
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

  return { jobId: job.id, matchedCount, unmatchedCount, totalShows: stats.totalShows, watchingCandidates, warning: stats.warning };
}

// Accepts the 4 CSV files from a TV Time GDPR export individually
// (the original flow — kept for anyone who already extracted them).
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

      const result = await processImport(userId, files);
      res.json(result);
    } catch (err) {
      console.error("Import failed:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Simpler flow: accepts the whole GDPR export .zip as one upload and
// finds the 4 needed CSVs inside it automatically (they can be
// nested in a subfolder, filenames are matched case-insensitively).
const NEEDED_FILES = ["user_tv_show_data.csv", "show_seen_episode_latest.csv", "followed_tv_show.csv", "tv_show_rate.csv"];

app.post("/import/tvtime-zip", upload.single("export_zip"), async (req, res) => {
  try {
    const userId = req.body.user_id;
    if (!userId) return res.status(400).json({ error: "user_id is required" });
    if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    const files = {};
    for (const needed of NEEDED_FILES) {
      const entry = entries.find((e) => e.entryName.toLowerCase().endsWith(needed));
      if (!entry) {
        return res.status(400).json({
          error: `Could not find ${needed} inside the uploaded zip. Make sure you uploaded the full TV Time GDPR export.`,
        });
      }
      files[needed] = entry.getData().toString("utf8");
    }

    const result = await processImport(userId, files);
    res.json(result);
  } catch (err) {
    console.error("Zip import failed:", err);
    res.status(500).json({ error: err.message });
  }
});

async function upsertShowProgress(userId, show, jobId) {
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
    });
  }
}

app.get("/import/status/:jobId", async (req, res) => {
  const { data, error } = await supabase.from("import_jobs").select("*").eq("id", req.params.jobId).single();
  if (error) return res.status(404).json({ error: "Job not found" });
  res.json(data);
});

app.post("/import/:jobId/sync-episodes", async (req, res) => {
  const { jobId } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const { data: jobShows, error } = await supabase
    .from("import_job_shows")
    .select("*")
    .eq("import_job_id", jobId)
    .eq("synced", false);
  if (error) return res.status(500).json({ error: error.message });

  let syncedCount = 0;
  let failedCount = 0;
  const failures = [];

  for (const jobShow of jobShows) {
    try {
      await syncShowProgress(supabase, {
        userId,
        showRowId: jobShow.show_id,
        tmdbId: jobShow.tmdb_id,
        episodesSeenCount: jobShow.episodes_seen_count,
      });
      await supabase.from("import_job_shows").update({ synced: true }).eq("id", jobShow.id);
      syncedCount++;
    } catch (err) {
      failedCount++;
      failures.push({ tmdbId: jobShow.tmdb_id, error: err.message });
      console.error(`Episode sync failed for tmdb_id ${jobShow.tmdb_id}:`, err.message);
    }
  }

  res.json({ totalShows: jobShows.length, syncedCount, failedCount, failures: failures.slice(0, 10) });
});

app.get("/import/:jobId/unmatched", async (req, res) => {
  const { data, error } = await supabase.from("import_unmatched").select("*").eq("import_job_id", req.params.jobId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/import/unmatched/:rowId/resolve", async (req, res) => {
  const { tmdbId, userId } = req.body;
  const { data: row, error } = await supabase
    .from("import_unmatched")
    .update({ resolved_tmdb_id: tmdbId, resolved: true })
    .eq("id", req.params.rowId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await upsertShowProgress(userId, { title: row.raw_title, match: { tmdbId }, episodesSeenCount: 0, isArchived: false }, row.import_job_id);
  res.json({ ok: true });
});

// AI recommendation chat. Uses Groq (openai/gpt-oss-120b) grounded
// with a summary of the user's watch history so suggestions aren't
// generic. GROQ_API_KEY must be set in Render's environment.
app.post("/ai/chat", async (req, res) => {
  try {
    const { userId, message, history = [] } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "userId and message are required" });

    const { data: watchlist } = await supabase
      .from("user_watchlist")
      .select("status, shows(title)")
      .eq("user_id", userId)
      .in("status", ["watching", "completed"])
      .order("updated_at", { ascending: false })
      .limit(60);

    const completedTitles = (watchlist || [])
      .filter((w) => w.status === "completed")
      .map((w) => w.shows?.title)
      .filter(Boolean);
    const watchingTitles = (watchlist || [])
      .filter((w) => w.status === "watching")
      .map((w) => w.shows?.title)
      .filter(Boolean);

    const systemPrompt = `You are Scenera's TV show recommendation assistant. Give concise, specific recommendations (2-4 shows max per answer), each with a one-sentence reason tied to the user's taste. Avoid generic disclaimers or long intros — get straight to the recommendations.

User's completed shows: ${completedTitles.slice(0, 40).join(", ") || "none yet"}
User's currently watching: ${watchingTitles.slice(0, 20).join(", ") || "none yet"}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error(`Groq API error (${groqRes.status}): ${errText}`);
    }
    const groqData = await groqRes.json();
    const reply = groqData.choices?.[0]?.message?.content || "Sorry, I couldn't come up with a suggestion right now.";
    res.json({ reply });
  } catch (err) {
    console.error("AI chat failed:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nextup backend running on port ${PORT}`));
