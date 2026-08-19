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
const { matchShows, searchShow } = require("./tmdbMatcher");
const { syncShowProgress, fetchAllEpisodes, cacheEpisodes } = require("./episodeSync");
const { sendFriendRequest, listFriends, acceptFriendRequest, declineFriendRequest, removeFriend, getFriendFavorites } = require("./friends");

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
  req.userEmail = data.user.email;
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "nextup-backend" });
});

const { getWatchProviders, getTopShows, getTrending, getGenres } = require("./discover");

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

// Same reasoning as the two routes above — public, cached, keeps the
// TMDB key server-side. Also lets the Explore "home" data (trending +
// genres + providers + top-shows) be prefetched cheaply right after
// login, since none of it hits TMDB uncached per request.
app.get("/discover/trending", asyncHandler(async (req, res) => {
  const shows = await getTrending();
  res.json(shows);
}));

app.get("/discover/genres", asyncHandler(async (req, res) => {
  const genres = await getGenres();
  res.json(genres);
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

// Feature flag — friend connections are being tried out live with
// two specific accounts before rolling out to everyone. Returns 404
// (not 403) for anyone else, so the feature is fully invisible
// rather than visibly "forbidden" for testers who don't have it yet.
const FRIENDS_FEATURE_EMAILS = ["knasiovas@gmail.com", "brati.arieta@gmail.com"];
function requireFriendsFeature(req, res, next) {
  if (!FRIENDS_FEATURE_EMAILS.includes(req.userEmail)) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

// Gives the frontend everything it needs to detect a "gap" in
// watched episodes across ALL seasons at once — the show detail
// screen otherwise only ever knows about the single season currently
// being viewed, which isn't enough to notice "you marked episode 5
// but never marked 1-4" if those earlier episodes are in a season
// the person never opened this visit. Reuses the same
// fetchAllEpisodes/cacheEpisodes pipeline the import already relies
// on, rather than duplicating that TMDB-fetching logic here.
app.get("/shows/:tmdbId/full-progress", requireAuth, asyncHandler(async (req, res) => {
  const tmdbId = req.params.tmdbId;

  const { data: showRow } = await supabase.from("shows").select("id").eq("tmdb_id", tmdbId).single();
  if (!showRow) {
    // Not tracked at all yet — nothing could possibly be marked
    // watched, so there's no gap to detect. (In practice the frontend
    // only calls this once a show is already tracked, since that's
    // the only way to mark an episode watched in the first place.)
    return res.json({ episodes: [], watchedEpisodeIds: [], showStatus: null });
  }

  const { episodes, showStatus } = await fetchAllEpisodes(tmdbId);
  const cached = await cacheEpisodes(supabase, showRow.id, episodes);

  const { data: watchedRows } = await supabase
    .from("watched_episodes")
    .select("episode_id")
    .eq("user_id", req.userId)
    .in("episode_id", cached.map((e) => e.id));

  res.json({
    episodes: cached.map((e) => ({ id: e.id, season_number: e.season_number, episode_number: e.episode_number })),
    watchedEpisodeIds: (watchedRows || []).map((w) => w.episode_id),
    showStatus,
  });
}));

app.post("/friends/request", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });
  const result = await sendFriendRequest(supabase, req.userId, email);
  res.json(result);
}));

// Real, in-app account deletion — required by Google Play policy
// alongside the web-based deletion link already in delete-account.html
// (that page stays as the fallback for someone who's already
// uninstalled the app). Deletes every row this account owns first —
// regardless of whether foreign keys cascade automatically — then
// deletes the auth.users row itself last, so nothing is ever left
// pointing at a user_id that no longer exists.
app.delete("/account", requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId;

  await supabase.from("watched_episodes").delete().eq("user_id", userId);
  await supabase.from("user_watchlist").delete().eq("user_id", userId);
  await supabase.from("ai_usage_daily").delete().eq("user_id", userId);
  await supabase.from("push_tokens").delete().eq("user_id", userId);
  await supabase.from("friend_connections").delete().or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);

  // Best-effort — import history and the avatar file aren't core
  // personal-identity data once disconnected from the account, so a
  // failure here shouldn't block the actual account deletion below.
  try {
    await supabase.from("import_jobs").delete().eq("user_id", userId);
  } catch (e) {
    console.error(`Import history cleanup failed for ${userId} (non-fatal):`, e.message);
  }
  try {
    await supabase.storage.from("avatars").remove([
      `${userId}/avatar.jpg`, `${userId}/avatar.jpeg`, `${userId}/avatar.png`, `${userId}/avatar.webp`,
    ]);
  } catch (e) {
    console.error(`Avatar cleanup failed for ${userId} (non-fatal):`, e.message);
  }

  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) throw error;

  res.json({ ok: true });
}));

app.get("/friends", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await listFriends(supabase, req.userId);
  res.json(result);
}));

app.post("/friends/:id/accept", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await acceptFriendRequest(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.post("/friends/:id/decline", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await declineFriendRequest(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.delete("/friends/:id", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await removeFriend(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.get("/friends/:id/favorites", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await getFriendFavorites(supabase, req.params.id, req.userId);
  res.json(result);
}));

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
    .limit(120);

  const completedTitles = (watchlist || [])
    .filter((w) => w.status === "completed")
    .map((w) => w.shows?.title)
    .filter(Boolean);
  const watchingTitles = (watchlist || [])
    .filter((w) => w.status === "watching")
    .map((w) => w.shows?.title)
    .filter(Boolean);

  const systemPrompt = `You are Scenera's TV show recommendation assistant. Give concise, specific recommendations (2-4 shows max per answer), each with a one-sentence reason tied to the user's taste. Avoid generic disclaimers or long intros — get straight to the recommendations.

Do NOT recommend anything in the user's completed or currently-watching lists below — only suggest shows they haven't already tracked.

User's completed shows: ${completedTitles.slice(0, 80).join(", ") || "none yet"}
User's currently watching: ${watchingTitles.slice(0, 40).join(", ") || "none yet"}`;

  // Shared by both the plain-text path (everyone) and the structured
  // path's fallback (see catch block below) — one place that knows
  // how to get an ordinary free-text recommendation out of Groq.
  async function getFreeTextReply() {
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
        max_tokens: 1500, // this model produces an internal reasoning trace before the actual reply, which can consume the whole token budget on its own for large watchlists (Sentry: finish_reason "length" with empty content, full reasoning trace)
      }),
    });
    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error(`Groq API error (${groqRes.status}): ${errText}`);
    }
    const groqData = await groqRes.json();
    const content = groqData.choices?.[0]?.message?.content;
    if (!content) {
      // This has been happening specifically when the person writes
      // in Greek — logging the actual shape Groq returned instead of
      // guessing why, so the next occurrence is diagnosable from
      // Render logs rather than a repeat of "no idea why."
      console.error("Groq returned no content. finish_reason:", groqData.choices?.[0]?.finish_reason, "full choice:", JSON.stringify(groqData.choices?.[0]));
      Sentry.captureMessage("Groq free-text reply had empty content", { extra: { groqChoice: groqData.choices?.[0] } });
    }
    return content || "Sorry, I couldn't come up with a suggestion right now.";
  }

  // response_format: json_object asks Groq to enforce valid JSON —
  // but the model can still occasionally fail that validation on its
  // own (a real Groq-side error, not a bug in our parsing), and that
  // must never surface as a hard error to the person using this. Any
  // failure here — the Groq call itself, or a response that yields
  // zero usable recommendations — falls back to a plain-text reply
  // (getFreeTextReply below), so the conversation always produces
  // *something* useful.
  try {
    // Every show the user has EVER tracked, any status (not just
    // completed/watching above, which were only ever meant as taste
    // context) — used below as a deterministic backstop. The prompt
    // instruction is a strong hint, but models can still slip, so
    // this cross-check guarantees a show already on the user's list
      // never gets recommended back to them, regardless of what the
      // model actually returns.
      const { data: trackedRows } = await supabase
        .from("user_watchlist")
        .select("shows(tmdb_id)")
        .eq("user_id", req.userId);
      const trackedTmdbIds = new Set((trackedRows || []).map((r) => r.shows?.tmdb_id).filter(Boolean));

      const structuredSystemPrompt = `You are Scenera's TV show recommendation assistant. Based on the conversation and the user's watch history below, recommend 5-6 shows tied to their taste — more than you'd normally suggest, since some may turn out to already be on the user's list and get filtered out before they're shown.
Respond ONLY with a JSON object in exactly this shape, no text outside the JSON: {"recommendations": [{"title": "Show Name", "reason": "one sentence tied to the user's taste"}]}

Try to avoid the user's completed/watching lists below where it's obvious, but don't spend time meticulously cross-checking every title against them — a separate system already filters out anything already tracked before the person sees it, so a few overlaps here are fine and expected.

User's completed shows: ${completedTitles.slice(0, 80).join(", ") || "none yet"}
User's currently watching: ${watchingTitles.slice(0, 40).join(", ") || "none yet"}`;

      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [{ role: "system", content: structuredSystemPrompt }, ...history, { role: "user", content: message }],
          temperature: 0.7,
          max_tokens: 1500, // was 500, then 800 — same root cause as the free-text path: this model's internal reasoning trace can consume the whole budget before the actual JSON content, especially for large watchlists
          response_format: { type: "json_object" },
        }),
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        throw new Error(`Groq API error (${groqRes.status}): ${errText}`);
      }
      const groqData = await groqRes.json();
      const parsed = JSON.parse(groqData.choices?.[0]?.message?.content || "{}");
      const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

      // Look each recommended title up on TMDB so the frontend gets a
      // real tmdb_id + poster to render as a tappable card — not just
      // a name. A title that doesn't resolve to any TMDB result (rare,
      // but possible — e.g. a slightly garbled title), or that turns
      // out to already be on the user's list (the backstop above),
      // is silently dropped rather than shown as a dead or redundant
      // card.
      const resolved = await Promise.all(
        recommendations.slice(0, 6).map(async (rec) => {
          try {
            const results = await searchShow(rec.title);
            if (!results || results.length === 0) return null;
            const best = results[0];
            if (trackedTmdbIds.has(best.id)) return null;
            return {
              tmdbId: best.id,
              title: best.name,
              posterPath: best.poster_path || null,
              reason: rec.reason || "",
            };
          } catch (e) {
            console.error(`TMDB lookup failed for AI recommendation "${rec.title}":`, e.message);
            return null;
          }
        })
      );

      const filtered = resolved.filter(Boolean).slice(0, 5);
      if (filtered.length === 0) {
        // Not a bug — the model can legitimately end up recommending
        // only shows that turn out to already be tracked, or titles
        // that don't resolve on TMDB. Handled here directly (not via
        // the catch block below) so this expected, recoverable case
        // doesn't get reported to Sentry as if it were an error.
        console.log("Structured AI response had no usable recommendations after filtering — falling back to free text");
        const reply = await getFreeTextReply();
        await supabase.from("ai_usage_daily").upsert(
          { user_id: req.userId, usage_date: today, count: currentCount + 1 },
          { onConflict: "user_id,usage_date" }
        );
        return res.json({ type: "text", reply });
      }

      await supabase.from("ai_usage_daily").upsert(
        { user_id: req.userId, usage_date: today, count: currentCount + 1 },
        { onConflict: "user_id,usage_date" }
      );
      return res.json({ type: "structured", recommendations: filtered });
    } catch (e) {
      console.error("Structured AI response failed, falling back to free text:", e.message);
      Sentry.captureException(e);
      const reply = await getFreeTextReply();
      await supabase.from("ai_usage_daily").upsert(
        { user_id: req.userId, usage_date: today, count: currentCount + 1 },
        { onConflict: "user_id,usage_date" }
      );
      return res.json({ type: "text", reply });
    }
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
