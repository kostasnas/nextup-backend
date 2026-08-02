// server.js — Nextup/Scenera backend
require("./instrument.js"); // Sentry — must load before anything else
const Sentry = require("@sentry/node");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const { parseGdprExport } = require("./importParser");
const { matchShows } = require("./tmdbMatcher");
const { syncShowProgress } = require("./episodeSync");

const app = express();

// Safety net: an unhandled promise rejection anywhere in the process
// (not just inside an Express request) crashes the whole Node process
// by default from Node 15+ — this is exactly what took the backend
// down before (express-rate-limit rejecting outside asyncHandler's
// try/catch, via the trust-proxy issue fixed below). Reporting to
// Sentry and NOT exiting keeps the server alive so one bad rejection
// can't take down every route/user at once. This is a backstop, not
// a substitute for fixing the actual source — every occurrence here
// should still get investigated and wrapped properly at its origin,
// the way we did for express-rate-limit (trust proxy) and
// tmdbThrottle.js's drainQueue().
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// Render sits behind a reverse proxy — without this, express-rate-limit
// throws on the X-Forwarded-For header it sees, as an unhandled
// rejection that crashes the whole process (not just the one route).
// "1" trusts only the immediate proxy hop (Render itself), not an
// arbitrary chain of forwarded headers.
app.set("trust proxy", 1);
// Capacitor's Android WebView (no custom hostname/androidScheme set
// in capacitor.config.json) loads the app from https://localhost, so
// that's the Origin header every real request from the app carries.
// http://localhost:5173 is Vite's dev server, kept so local `npm run
// dev` testing keeps working. Requests with no Origin header at all
// (native HTTP clients, curl, server-to-server, cron pings) are
// allowed through — CORS is a browser-enforced mechanism and doesn't
// meaningfully restrict non-browser callers anyway, and every
// data-mutating route still requires a valid Supabase JWT regardless
// of origin.
// "null" is added for the local broadcast-test-tool.html — browsers
// send the literal string "null" as Origin when a page is opened
// directly from disk (file://) rather than served over http(s). Only
// relevant for that one local testing tool; every real request from
// the Scenera app itself still comes from https://localhost.
const ALLOWED_ORIGINS = ["https://localhost", "http://localhost:5173", "null"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json());

// Two separate instances since the two import paths have very
// different realistic sizes. Individual TV Time CSV exports are a
// few MB at most even for a heavy watch history; the full "download
// all my data" GDPR zip bundles 50+ files and can be much larger.
// Without an explicit limit, multer's memoryStorage will happily
// buffer an arbitrarily large upload straight into RAM on Render's
// free tier — the same kind of unbounded-resource risk that took the
// whole process down before, just via a different door.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per individual CSV field
});
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB for the full GDPR export zip
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired session" });

  req.userId = data.user.id;
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "nextup-backend" });
});

const { getWatchProviders, getTopShows } = require("./discover");

// Streaming-provider-aware "Top Shows" — public, cached, no auth
// needed since results are identical for everyone in the same
// region. Proxied through here instead of calling TMDB directly from
// the app so the API key doesn't need to live in the client bundle
// for this specific feature.
app.get("/discover/watch-providers", asyncHandler(async (req, res) => {
  const region = (req.query.region || "US").toUpperCase();
  const providers = await getWatchProviders(region);
  res.json(providers);
}));

app.get("/discover/top-shows", asyncHandler(async (req, res) => {
  const region = (req.query.region || "US").toUpperCase();
  const providerId = req.query.provider_id || null;
  const shows = await getTopShows({ region, providerId });
  res.json(shows);
}));

app.get("/health-full", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("shows").select("id").limit(1);
  if (error) throw error;
  res.json({ status: "ok", db: "reachable" });
}));

async function processImport(userId, files) {
  const { shows, episodeLogByShow, emotionLogByShow, stats } = parseGdprExport(files);
  const watchingCandidates = shows.filter((s) => s.episodesSeenCount > 0).length;
  console.log(
    `Parsed ${shows.length} shows, ${watchingCandidates} have episodesSeenCount > 0. ` +
    `Episode log: ${stats.hasEpisodeLog ? "present" : "not present"}, Emotion log: ${stats.hasEmotionLog ? "present" : "not present"}.`
  );

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
      await upsertShowProgress(userId, show, job.id, {
        episodeLog: episodeLogByShow[show.title] || null,
        emotionLog: emotionLogByShow[show.title] || null,
      });
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

app.post(
  "/import/tvtime",
  requireAuth,
  uploadCsv.fields([
    { name: "user_tv_show_data", maxCount: 1 },
    { name: "show_seen_episode_latest", maxCount: 1 },
    { name: "followed_tv_show", maxCount: 1 },
    { name: "tv_show_rate", maxCount: 1 },
    { name: "seen_episode_source", maxCount: 1 },
    { name: "episode_emotion", maxCount: 1 },
    { name: "tracking-prod-records-v2", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const files = {};
    for (const [field, arr] of Object.entries(req.files)) {
      files[`${field}.csv`] = arr[0].buffer.toString("utf8");
    }
    const result = await processImport(req.userId, files);
    res.json(result);
  })
);

const REQUIRED_FILES = ["user_tv_show_data.csv", "show_seen_episode_latest.csv", "followed_tv_show.csv", "tv_show_rate.csv"];
const OPTIONAL_FILES = ["seen_episode_source.csv", "episode_emotion.csv", "tracking-prod-records-v2.csv"];

app.post("/import/tvtime-zip", requireAuth, uploadZip.single("export_zip"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries();

  const files = {};
  for (const needed of REQUIRED_FILES) {
    const entry = entries.find((e) => e.entryName.toLowerCase().endsWith(needed));
    if (!entry) {
      return res.status(400).json({
        error: `Could not find ${needed} inside the uploaded zip. Make sure you uploaded the full TV Time GDPR export.`,
      });
    }
    files[needed] = entry.getData().toString("utf8");
  }
  for (const optional of OPTIONAL_FILES) {
    const entry = entries.find((e) => e.entryName.toLowerCase().endsWith(optional));
    if (entry) files[optional] = entry.getData().toString("utf8");
  }

  const result = await processImport(req.userId, files);
  res.json(result);
}));

async function upsertShowProgress(userId, show, jobId, extras = {}) {
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

async function getOwnedJob(jobId, userId) {
  const { data, error } = await supabase.from("import_jobs").select("*").eq("id", jobId).single();
  if (error || !data) {
    const notFound = new Error("Job not found");
    notFound.status = 404;
    throw notFound;
  }
  if (data.user_id !== userId) {
    const forbidden = new Error("Not your import job");
    forbidden.status = 403;
    throw forbidden;
  }
  return data;
}

app.get("/import/status/:jobId", requireAuth, asyncHandler(async (req, res) => {
  const job = await getOwnedJob(req.params.jobId, req.userId);
  res.json(job);
}));

app.post("/import/:jobId/sync-episodes", requireAuth, asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  await getOwnedJob(jobId, req.userId);

  const { data: jobShows, error } = await supabase
    .from("import_job_shows")
    .select("*")
    .eq("import_job_id", jobId)
    .eq("synced", false);
  if (error) throw error;

  let syncedCount = 0;
  let failedCount = 0;
  const failures = [];

  const CONCURRENCY = 5;
  for (let i = 0; i < jobShows.length; i += CONCURRENCY) {
    const batch = jobShows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (jobShow) => {
        try {
          await syncShowProgress(supabase, {
            userId: req.userId,
            showRowId: jobShow.show_id,
            tmdbId: jobShow.tmdb_id,
            episodesSeenCount: jobShow.episodes_seen_count,
            episodeLog: jobShow.episode_log,
            emotionLog: jobShow.emotion_log,
          });
          await supabase.from("import_job_shows").update({ synced: true }).eq("id", jobShow.id);
          syncedCount++;
        } catch (err) {
          failedCount++;
          failures.push({ tmdbId: jobShow.tmdb_id, error: err.message });
          console.error(`Episode sync failed for tmdb_id ${jobShow.tmdb_id}:`, err.message);
        }
      })
    );
  }

  res.json({ totalShows: jobShows.length, syncedCount, failedCount, failures: failures.slice(0, 10) });
}));

app.get("/import/:jobId/unmatched", requireAuth, asyncHandler(async (req, res) => {
  await getOwnedJob(req.params.jobId, req.userId);
  const { data, error } = await supabase.from("import_unmatched").select("*").eq("import_job_id", req.params.jobId);
  if (error) throw error;
  res.json(data);
}));

app.post("/import/unmatched/:rowId/resolve", requireAuth, asyncHandler(async (req, res) => {
  const { tmdbId } = req.body;
  const { data: row, error } = await supabase
    .from("import_unmatched")
    .select("*, import_jobs!inner(user_id)")
    .eq("id", req.params.rowId)
    .single();
  if (error || !row) return res.status(404).json({ error: "Unmatched row not found" });
  if (row.import_jobs.user_id !== req.userId) return res.status(403).json({ error: "Not your import job" });

  await supabase.from("import_unmatched").update({ resolved_tmdb_id: tmdbId, resolved: true }).eq("id", req.params.rowId);
  await upsertShowProgress(req.userId, { title: row.raw_title, match: { tmdbId }, episodesSeenCount: 0, isArchived: false }, row.import_job_id, {});
  res.json({ ok: true });
}));

const aiChatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again in a minute." },
});

const AI_DAILY_LIMIT = 20;

app.post("/ai/chat", requireAuth, aiChatRateLimiter, asyncHandler(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await supabase
    .from("ai_usage_daily")
    .select("count")
    .eq("user_id", req.userId)
    .eq("usage_date", today)
    .single();
  const currentCount = usage?.count || 0;

  if (currentCount >= AI_DAILY_LIMIT) {
    return res.status(429).json({ error: "You've reached today's AI chat limit. Try again tomorrow." });
  }

  const { data: watchlist } = await supabase
    .from("user_watchlist")
    .select("status, shows(title)")
    .eq("user_id", req.userId)
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

  await supabase.from("ai_usage_daily").upsert(
    { user_id: req.userId, usage_date: today, count: currentCount + 1 },
    { onConflict: "user_id,usage_date" }
  );

  res.json({ reply });
}));

const { sendDailyUpcomingNotifications, checkUpcomingPremieres, sendDailyEngagementNudge } = require("./pushNotifications");
const { reconcileWatchingStatuses } = require("./statusReconciliation");

// Triggers the full daily maintenance sweep:
//   1. Reconcile statuses — catches any "watching" show that's
//      actually fully caught up and flips it to completed/up_to_date,
//      so nothing stays stuck from imports or multi-session catch-ups.
//   2. "New episode is out today" notifications for watching shows.
//   3. "Up to date" shows premiering within 5 days — promotes to
//      Watching with a countdown and notifies.
//   4. A generic daily re-engagement nudge to every registered device
//      (helps general habit-forming, and specifically helps satisfy
//      Google Play Closed Testing's daily-engagement review check).
// Protected by a shared secret since this is meant to be called once
// a day by an external scheduler (e.g. cron-job.org), not by the app
// or by end users. Registered for both GET and POST since some free
// cron services only support GET.
const dailyMaintenanceHandler = asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const reconciliation = await reconcileWatchingStatuses(supabase);
  const dailyResult = await sendDailyUpcomingNotifications(supabase);
  const premiereResult = await checkUpcomingPremieres(supabase);
  res.json({ reconciliation, dailyEpisodes: dailyResult, upcomingPremieres: premiereResult });
});
app.get("/notifications/send-daily-upcoming", dailyMaintenanceHandler);
app.post("/notifications/send-daily-upcoming", dailyMaintenanceHandler);

// Separate endpoint (and separate cron schedule — e.g. 21:00 instead
// of 18:30) so the generic "did you watch today?" nudge never lands
// in the same moment as the "new episode is out" notification. Two
// pushes arriving together read as spam; spread out, each has a
// clear, distinct reason to exist.
const engagementNudgeHandler = asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await sendDailyEngagementNudge(supabase);
  res.json(result);
});
app.get("/notifications/send-engagement-nudge", engagementNudgeHandler);
app.post("/notifications/send-engagement-nudge", engagementNudgeHandler);

// Same reconciliation, exposed on its own so it can be run immediately
// (e.g. to fix already-stuck statuses right now) without waiting for
// the daily schedule, or re-run manually any time.
const reconcileOnlyHandler = asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await reconcileWatchingStatuses(supabase);
  res.json(result);
});
app.get("/admin/reconcile-statuses", reconcileOnlyHandler);
app.post("/admin/reconcile-statuses", reconcileOnlyHandler);

// Sends a custom push notification to every registered device —
// reusable for announcements like "new version available", not tied
// to any show/episode. Title and body are supplied in the request
// body, e.g.: { "title": "Update available", "body": "..." }
const { sendBroadcastNotification } = require("./broadcastNotification");
app.post("/admin/broadcast", asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await sendBroadcastNotification(supabase, req.body);
  res.json(result);
}));

Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  // multer throws a distinct error type (not our own asyncHandler
  // path) when an upload is rejected for size/shape reasons — surface
  // that as a normal 400 instead of a generic 500, since it's a
  // client mistake (or abuse attempt), not a server fault.
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload rejected: ${err.message}` });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nextup backend running on port ${PORT}`));
