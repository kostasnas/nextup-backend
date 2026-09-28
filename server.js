// server.js — Nextup/Scenera backend
require("./instrument.js"); // Sentry — must load before anything else
const Sentry = require("@sentry/node");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { createClient } = require("@supabase/supabase-js");
const { parseGdprExport } = require("./importParser");
const { matchShows, searchShow, searchMovie } = require("./tmdbMatcher");
const { syncShowProgress, fetchAllEpisodes, cacheEpisodes } = require("./episodeSync");
const { sendFriendRequest, listFriends, acceptFriendRequest, declineFriendRequest, removeFriend, getFriendFavorites } = require("./friends");
const { sendMessage, getMessages, deleteMessage } = require("./messages");
const { getComments, getCommentCountsForShow, addComment, deleteComment, toggleCommentLike, getEpisodeContext } = require("./episodeComments");
const { getMovieWatchlist, setMovieStatus, updateMovieEntry, removeMovie } = require("./movies");
const { getFavoriteCharacters, addFavoriteCharacter, removeFavoriteCharacter, getCharacterVoteCounts } = require("./favoriteCharacters");
const { listFeatureRequests, createFeatureRequest, toggleVote } = require("./featureRequests");
const { logRewatch, removeRewatch, getRewatchCountsForShow } = require("./episodeRewatches");
const { findUserByEmail, findUserByUsername } = require("./db");
const { getShowCommunityRating } = require("./showRatings");
const { createNotification, listNotifications, getUnreadCount, markAllRead, markRead } = require("./notifications");

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
app.use(helmet());

// Catches abuse/flooding across every endpoint, not just AI chat —
// generous enough that no real user should ever hit it in normal use.
// The stricter aiChatRateLimiter below still applies on top of this
// for that one specifically expensive route.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again later." },
}));
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
//
// https://scenera-web.vercel.app is the web/PWA build's real deployed
// origin — added once that build started making real browser fetches
// here, which (unlike the Android WebView) are actually subject to
// CORS enforcement.
const ALLOWED_ORIGINS = ["https://localhost", "http://localhost:5173", "null", "https://scenera-web.vercel.app", "https://scenera.online", "https://www.scenera.online"];
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

app.get("/", async (req, res) => {
  // Touches the database on every health check — this is also what
  // keeps the free-tier Supabase project from auto-pausing after 7
  // days with no activity (the old static "ok" response never
  // touched it at all). A DB hiccup here doesn't fail the health
  // check itself — the server process is still genuinely up — but
  // it's logged so it's visible if it keeps happening.
  try {
    await supabase.from("shows").select("id").limit(1);
    res.json({ status: "ok", service: "nextup-backend" });
  } catch (e) {
    console.error("Health check DB ping failed:", e.message);
    res.json({ status: "ok", service: "nextup-backend", db: "unreachable" });
  }
});

const { getWatchProviders, getShowWatchProviders, getMovieWatchProviders, getShowBackdrop, getTopShows, getTrending, getGenres, getPersonDetails } = require("./discover");

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

// Where a specific show can be streamed — for the "Where to watch"
// section on Show Detail. Public, cached, no auth needed (same
// reasoning as above).
app.get("/shows/:id/watch-providers", asyncHandler(async (req, res) => {
  const region = (req.query.region || "US").toUpperCase();
  const providers = await getShowWatchProviders(req.params.id, region);
  res.json(providers);
}));

app.get("/movies/:id/watch-providers", asyncHandler(async (req, res) => {
  const region = (req.query.region || "US").toUpperCase();
  const providers = await getMovieWatchProviders(req.params.id, region);
  res.json(providers);
}));

// Actor/cast-member detail card — photo, bio, filmography. Public,
// cached, no auth needed (same reasoning as the watch-providers routes).
app.get("/people/:id", asyncHandler(async (req, res) => {
  const person = await getPersonDetails(req.params.id);
  res.json(person);
}));

// Scenera's own aggregate rating for a show — public, no auth needed,
// not cached since it's a cheap aggregate query and changes as people
// rate the show.
app.get("/shows/:id/community-rating", asyncHandler(async (req, res) => {
  const rating = await getShowCommunityRating(req.params.id);
  res.json(rating);
}));

// Public per-episode comments — visible to every Scenera user, not
// just friends. Free for everyone; this is the community/discussion
// feature, not a Pro perk.
app.get("/shows/:id/comment-counts", requireAuth, asyncHandler(async (req, res) => {
  const counts = await getCommentCountsForShow(req.params.id);
  res.json(counts);
}));

app.get("/shows/:id/rewatch-counts", requireAuth, asyncHandler(async (req, res) => {
  const counts = await getRewatchCountsForShow(req.userId, req.params.id);
  res.json(counts);
}));

app.post("/episodes/:id/rewatch", requireAuth, asyncHandler(async (req, res) => {
  const result = await logRewatch(supabase, req.userId, req.params.id);
  res.json(result);
}));

app.delete("/episodes/:id/rewatch", requireAuth, asyncHandler(async (req, res) => {
  const result = await removeRewatch(supabase, req.userId, req.params.id);
  res.json(result);
}));

// Movie watchlist — separate from the shows system entirely, since
// movies have no episodes, just planned/watched.
app.get("/movies", requireAuth, asyncHandler(async (req, res) => {
  const list = await getMovieWatchlist(supabase, req.userId);
  res.json(list);
}));

app.post("/movies/watchlist", requireAuth, asyncHandler(async (req, res) => {
  const { tmdb_id, title, poster_path, release_date, runtime, overview, status } = req.body;
  if (!tmdb_id || !title || !status) return res.status(400).json({ error: "tmdb_id, title, and status are required" });
  const result = await setMovieStatus(supabase, req.userId, { tmdb_id, title, poster_path, release_date, runtime, overview }, status);
  res.json(result);
}));

app.patch("/movies/watchlist/:movieId", requireAuth, asyncHandler(async (req, res) => {
  const { status, rating, is_favorite, watched_at } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (rating !== undefined) updates.rating = rating;
  if (is_favorite !== undefined) updates.is_favorite = is_favorite;
  if (watched_at !== undefined) updates.watched_at = watched_at;
  const result = await updateMovieEntry(supabase, req.userId, req.params.movieId, updates);
  res.json(result);
}));

app.delete("/movies/watchlist/:movieId", requireAuth, asyncHandler(async (req, res) => {
  const result = await removeMovie(supabase, req.userId, req.params.movieId);
  res.json(result);
}));

app.get("/favorite-characters", requireAuth, asyncHandler(async (req, res) => {
  const list = await getFavoriteCharacters(supabase, req.userId);
  res.json(list);
}));

app.post("/favorite-characters", requireAuth, asyncHandler(async (req, res) => {
  const { tmdbPersonId, personName, profilePath, sourceType, sourceTmdbId, sourceTitle, characterName } = req.body;
  if (!tmdbPersonId || !personName || !sourceType || !sourceTmdbId || !sourceTitle) {
    return res.status(400).json({ error: "tmdbPersonId, personName, sourceType, sourceTmdbId, and sourceTitle are required" });
  }
  const result = await addFavoriteCharacter(supabase, req.userId, { tmdbPersonId, personName, profilePath, sourceType, sourceTmdbId, sourceTitle, characterName });
  res.json(result);
}));

app.delete("/favorite-characters/:sourceType/:sourceTmdbId/:tmdbPersonId", requireAuth, asyncHandler(async (req, res) => {
  const result = await removeFavoriteCharacter(supabase, req.userId, req.params.tmdbPersonId, req.params.sourceType, req.params.sourceTmdbId);
  res.json(result);
}));

// Public "Fictional Character Vote" tally — no auth required, same
// as /roadmap: this is a per-show/movie leaderboard everyone sees,
// not personal data. { [tmdbPersonId]: voteCount }.
app.get("/character-votes/:sourceType/:sourceTmdbId", asyncHandler(async (req, res) => {
  const counts = await getCharacterVoteCounts(supabase, req.params.sourceType, req.params.sourceTmdbId);
  res.json(counts);
}));

app.get("/feature-requests", requireAuth, asyncHandler(async (req, res) => {
  const list = await listFeatureRequests(supabase, req.userId);
  res.json(list);
}));

// Public, read-only mirror of the feature-request board — shown on
// the web landing page (before sign-in) so visitors and the TV Time
// Refugees community can see what's planned/shipped without an
// account. No vote counts hidden, but no per-user fields (isMine,
// votedByMe) since there's no user here.
app.get("/roadmap", asyncHandler(async (req, res) => {
  const list = await listFeatureRequests(supabase, null);
  const publicList = list.map(({ id, title, description, status, createdAt, voteCount }) => ({
    id, title, description, status, createdAt, voteCount,
  }));
  res.json(publicList);
}));

app.post("/feature-requests", requireAuth, asyncHandler(async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });
  if (title.length > 140) return res.status(400).json({ error: "title must be 140 characters or fewer" });
  if (description.length > 1000) return res.status(400).json({ error: "description must be 1000 characters or fewer" });
  const created = await createFeatureRequest(supabase, req.userId, title, description);
  res.json(created);
}));

app.post("/feature-requests/:id/vote", requireAuth, asyncHandler(async (req, res) => {
  const result = await toggleVote(supabase, req.userId, req.params.id);
  res.json(result);
}));

app.get("/episodes/:id/comments", requireAuth, asyncHandler(async (req, res) => {
  const comments = await getComments(req.params.id, req.userId);
  res.json(comments);
}));

app.post("/episodes/:id/comments", requireAuth, asyncHandler(async (req, res) => {
  const { content, imageUrl, parentId } = req.body;
  const trimmed = (content || "").trim();
  if (!trimmed && !imageUrl) return res.status(400).json({ error: "content or imageUrl is required" });
  const comment = await addComment(supabase, req.params.id, req.userId, trimmed, imageUrl, parentId || null);

  // In-app only, not a push — see notifications.js. Same fire-and-forget
  // pattern as the like notification below — notify the comment being
  // replied to's author, never for replying to your own comment.
  if (comment.parentAuthorId && comment.parentAuthorId !== req.userId) {
    getEpisodeContext(req.params.id)
      .then((ctx) => {
        const where = ctx ? `${ctx.show_title} S${ctx.season_number}E${ctx.episode_number}` : "an episode";
        return createNotification(supabase, comment.parentAuthorId, {
          type: "comment_reply",
          title: "Someone replied to your comment",
          body: `New reply on ${where}: "${trimmed.slice(0, 80)}"`,
          data: { episodeId: req.params.id, label: where },
        });
      })
      .catch((e) => console.error("Failed to create comment-reply notification:", e.message));
  }

  res.json(comment);
}));

app.delete("/comments/:id", requireAuth, asyncHandler(async (req, res) => {
  const result = await deleteComment(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.post("/comments/:id/like", requireAuth, asyncHandler(async (req, res) => {
  const result = await toggleCommentLike(supabase, req.userId, req.params.id);

  // In-app only, not a push — see notifications.js. Notify the
  // comment's author, but never for liking your own comment, and
  // never let a notification failure fail the like itself —
  // fire-and-forget with its own catch.
  if (result.liked && result.commentAuthorId !== req.userId) {
    getEpisodeContext(result.episodeId)
      .then((ctx) => {
        const where = ctx ? `${ctx.show_title} S${ctx.season_number}E${ctx.episode_number}` : "an episode";
        return createNotification(supabase, result.commentAuthorId, {
          type: "comment_like",
          title: "Someone liked your comment",
          body: `Your comment on ${where} got a like.`,
          data: { episodeId: result.episodeId, label: where },
        });
      })
      .catch((e) => console.error("Failed to create comment-like notification:", e.message));
  }

  res.json({ liked: result.liked, likeCount: result.likeCount });
}));

app.get("/notifications", requireAuth, asyncHandler(async (req, res) => {
  const [items, unreadCount] = await Promise.all([
    listNotifications(req.userId),
    getUnreadCount(req.userId),
  ]);
  res.json({ items, unreadCount });
}));

app.post("/notifications/mark-all-read", requireAuth, asyncHandler(async (req, res) => {
  const result = await markAllRead(supabase, req.userId);
  res.json(result);
}));

app.post("/notifications/:id/read", requireAuth, asyncHandler(async (req, res) => {
  const result = await markRead(supabase, req.userId, req.params.id);
  res.json(result);
}));

// GIF picker for episode comments (EpisodeCommentsScreen) — proxied
// through the backend, unlike TMDB's key, so GIPHY_API_KEY stays a
// server-side secret rather than shipping inside the Android bundle.
// requireAuth just to keep our (rate-limited, 100/hr on the beta key)
// Giphy quota from being spent by anyone outside the app. Returns the
// same shape either way: { gifs: [{ id, url, previewUrl }] } — url is
// what gets stored as the comment's image_url (same column real photo
// uploads already use, see addComment/episodeComments.js), previewUrl
// is a smaller version for the picker grid.
function mapGiphyResults(data) {
  return (data.data || []).map((g) => ({
    id: g.id,
    url: g.images?.fixed_height?.url || g.images?.original?.url,
    previewUrl: g.images?.fixed_width_small?.url || g.images?.fixed_height_small?.url,
  })).filter((g) => g.url);
}

app.get("/gifs/search", requireAuth, asyncHandler(async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ gifs: [] });
  const giphyRes = await fetch(
    `https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
  );
  if (!giphyRes.ok) return res.status(502).json({ error: "GIF search failed" });
  const data = await giphyRes.json();
  res.json({ gifs: mapGiphyResults(data) });
}));

app.get("/gifs/trending", requireAuth, asyncHandler(async (req, res) => {
  const giphyRes = await fetch(
    `https://api.giphy.com/v1/gifs/trending?api_key=${process.env.GIPHY_API_KEY}&limit=24&rating=pg-13`
  );
  if (!giphyRes.ok) return res.status(502).json({ error: "GIF trending fetch failed" });
  const data = await giphyRes.json();
  res.json({ gifs: mapGiphyResults(data) });
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
  const { shows, movies, episodeLogByShow, emotionLogByShow, stats } = parseGdprExport(files);
  const watchingCandidates = shows.filter((s) => s.episodesSeenCount > 0).length;
  console.log(
    `Parsed ${shows.length} shows, ${watchingCandidates} have episodesSeenCount > 0. ` +
    `Episode log: ${stats.hasEpisodeLog ? "present" : "not present"}, Emotion log: ${stats.hasEmotionLog ? "present" : "not present"}. ` +
    `Movies: ${movies.length} found (best-effort — see importParser.js caveat).`
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

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const results = await searchMovie(movie.title);
      if (!results || results.length === 0) { movieUnmatchedCount++; continue; }
      const best = results[0];
      await setMovieStatus(supabase, userId, {
        tmdb_id: best.id,
        title: best.title,
        poster_path: best.poster_path,
        release_date: best.release_date || null,
        runtime: null,
        overview: best.overview || null,
      }, "watched");
      movieMatchedCount++;
    } catch (e) {
      console.error(`Movie import: failed to match/insert "${movie.title}":`, e.message);
      movieUnmatchedCount++;
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

  return {
    jobId: job.id, matchedCount, unmatchedCount, totalShows: stats.totalShows, watchingCandidates, warning: stats.warning,
    movieMatchedCount, movieUnmatchedCount, totalMovies: stats.totalMovies,
  };
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
const OPTIONAL_FILES = [
  "seen_episode_source.csv", "episode_emotion.csv", "tracking-prod-records-v2.csv",
  "seen_movie.csv", "seen_movie_source.csv", "movie_seen.csv", "user_movie_data.csv",
];

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

const AI_DAILY_LIMIT = 5;

// Must exactly match the entitlement identifier configured in the
// Must exactly match the entitlement IDENTIFIER configured in the
// RevenueCat dashboard — "scenera_pro" (not the display name "Scenera Pro").
const REVENUECAT_ENTITLEMENT_ID = "scenera_pro";
const REVENUECAT_SECRET_KEY = process.env.REVENUECAT_SECRET_KEY;

// Asks RevenueCat directly whether this user currently holds an
// active "Scenera Pro" entitlement — the RevenueCat app_user_id is
// always the same as our own Supabase user id (see how the SDK is
// configured on the frontend), so no extra mapping is needed.
// Fails closed (treats errors as "not Pro") rather than open, since
// the failure mode of under-granting Pro is a minor inconvenience,
// while over-granting it would mean unlimited free AI usage.
async function isUserPro(userId) {
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${userId}`, {
      headers: { Authorization: `Bearer ${REVENUECAT_SECRET_KEY}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const entitlement = data.subscriber?.entitlements?.[REVENUECAT_ENTITLEMENT_ID];
    if (!entitlement) return false;
    if (!entitlement.expires_date) return true; // non-expiring entitlement
    return new Date(entitlement.expires_date) > new Date();
  } catch (e) {
    console.error("RevenueCat Pro check failed:", e.message);
    return false;
  }
}

// Friends is a Pro perk. Returns 403 (not 404) for non-Pro users —
// unlike the old email-allowlist version, the feature is now meant to
// be visible-but-locked in the UI (an upsell), not hidden entirely.
async function requireFriendsFeature(req, res, next) {
  const pro = await isUserPro(req.userId);
  if (!pro) {
    return res.status(403).json({ error: "Friends requires Scenera Pro." });
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
// Powers the Android home-screen widget — the single soonest-upcoming
// unwatched episode across everything the user is tracking. Kept to
// exactly one item for a clean, simple V1 widget rather than a list.
app.get("/widget/next-up", requireAuth, asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // Watched status is embedded per-candidate-episode below (scoped to
  // this user via .eq("watched_episodes.user_id", ...)) rather than
  // fetched as one big watched_episodes list for the whole account.
  // Supabase's API caps any single .select() at 1000 rows by default;
  // a long-time user's full watched history easily exceeds that, and
  // the truncated result silently made already-watched episodes look
  // unwatched again (this is what caused the stale/wrong widget data
  // bug — see "next up"/"ready to watch" reports from 2026-09-27).
  const { data: rows, error } = await supabase
    .from("episodes")
    .select(`
      id, air_date, show_id,
      shows!inner(id, tmdb_id, title, poster_path,
        user_watchlist!inner(user_id, status)
      ),
      watched_episodes(user_id)
    `)
    .gte("air_date", today)
    .eq("shows.user_watchlist.user_id", req.userId)
    .in("shows.user_watchlist.status", ["watching", "up_to_date"])
    .eq("watched_episodes.user_id", req.userId)
    .order("air_date", { ascending: true })
    .limit(20); // small buffer since we still filter already-watched ones below
  if (error) throw error;

  const isWatched = (r) => Array.isArray(r.watched_episodes) && r.watched_episodes.length > 0;
  const next = (rows || []).find((r) => !isWatched(r));
  if (!next) return res.json({ hasNext: false });

  // Progress-bar data for Widget 1: of this show's episodes that have
  // already aired, how many has the user watched. "currentEpisode" is
  // the next one up (watchedCount + 1), matching the "Ep X of Y"
  // phrasing the widget shows rather than a raw watched count. Same
  // embedded-watched-status approach as above, scoped to just this
  // show's aired episodes (never the user's whole watch history).
  const { data: showEpisodes, error: epErr } = await supabase
    .from("episodes")
    .select("id, watched_episodes(user_id)")
    .eq("show_id", next.show_id)
    .not("air_date", "is", null)
    .lte("air_date", today)
    .eq("watched_episodes.user_id", req.userId);
  if (epErr) throw epErr;

  const totalEpisodes = (showEpisodes || []).length;
  const watchedCount = (showEpisodes || []).filter(isWatched).length;
  const currentEpisode = totalEpisodes > 0 ? Math.min(watchedCount + 1, totalEpisodes) : 0;
  const progressPercentage = totalEpisodes > 0 ? Math.round((watchedCount / totalEpisodes) * 100) : 0;

  res.json({
    hasNext: true,
    tmdbId: next.shows.tmdb_id,
    title: next.shows.title,
    airDate: next.air_date,
    posterPath: next.shows.poster_path,
    currentEpisode,
    totalEpisodes,
    progressPercentage,
  });
}));

// Shared by /widget/ready-to-watch and /widget/continue-watching:
// the earliest already-aired, unwatched episode for EACH show the
// user is actively tracking. Queried one show at a time (the tracked
// shows list itself is small — dozens at most) rather than one
// global "most recently aired 300 episodes across the whole account"
// query: that global-and-capped shape was itself a second, subtler
// version of the truncation bug fixed above. If a user tracks enough
// shows, the true gap in one show (e.g. "still on S2E2") can be
// older than 300 OTHER episodes that aired more recently across
// every other tracked show, so it would fall outside the global
// window and silently never be considered — the widget would then
// jump straight to a later, in-window episode (e.g. S3E1) as if it
// were the earliest gap. Scoping the query per show sidesteps that
// entirely: each show's own episode count is small, so no arbitrary
// cross-account limit is ever in play.
//
// Which show to lead with, among several with a gap, is picked by
// RECENCY OF ACTUAL VIEWING (each show's most recent watched_at) —
// not by whose gap is chronologically oldest. Someone can leave one
// show mid-way and be actively bingeing a different one; the show
// they last actually marked an episode watched on is the one they're
// "continuing", regardless of which show's unwatched episode aired
// longest ago. A show with no viewing history at all yet (e.g. just
// added, nothing marked watched) sorts after every show with any
// history, ordered among themselves by gap air date as before.
async function getReadyToWatchByShow(userId, today) {
  const { data: trackedRows, error: trackedErr } = await supabase
    .from("user_watchlist")
    .select("show_id, shows(id, tmdb_id, title, poster_path)")
    .eq("user_id", userId)
    .in("status", ["watching", "up_to_date"]);
  if (trackedErr) throw trackedErr;

  const perShow = await Promise.all(
    (trackedRows || [])
      .filter((tw) => tw.shows)
      .map(async (tw) => {
        const [{ data: eps, error: epErr }, { data: lastWatchedRows, error: lastErr }] = await Promise.all([
          supabase
            .from("episodes")
            .select("id, show_id, season_number, episode_number, air_date, watched_episodes(user_id)")
            .eq("show_id", tw.show_id)
            .not("air_date", "is", null)
            .lt("air_date", today)
            .eq("watched_episodes.user_id", userId)
            .order("air_date", { ascending: true })
            .limit(500), // generous per-show cap — a single show/season combo is never anywhere near this
          supabase
            .from("watched_episodes")
            .select("watched_at, episodes!inner(show_id)")
            .eq("user_id", userId)
            .eq("episodes.show_id", tw.show_id)
            .order("watched_at", { ascending: false })
            .limit(1),
        ]);
        if (epErr) throw epErr;
        if (lastErr) throw lastErr;

        const gaps = (eps || []).filter((e) => !(Array.isArray(e.watched_episodes) && e.watched_episodes.length > 0));
        if (gaps.length === 0) return null;
        const lastWatchedAt = (lastWatchedRows || [])[0]?.watched_at || null;
        // gaps[0] is the earliest unwatched-aired episode (eps was
        // fetched air_date-ascending) — kept as the "lead" episode for
        // this show, same as before. gapCount is ALL of this show's
        // unwatched-aired episodes, not just the one we lead with —
        // needed so the widget's total below reflects real episode
        // counts instead of one-per-show.
        return { ...gaps[0], shows: tw.shows, lastWatchedAt, gapCount: gaps.length };
      })
  );

  return perShow.filter(Boolean).sort((a, b) => {
    // Both have viewing history — most recently watched show first.
    if (a.lastWatchedAt && b.lastWatchedAt) {
      if (a.lastWatchedAt !== b.lastWatchedAt) return a.lastWatchedAt > b.lastWatchedAt ? -1 : 1;
    } else if (a.lastWatchedAt || b.lastWatchedAt) {
      // Only one has any viewing history — that one leads.
      return a.lastWatchedAt ? -1 : 1;
    }
    // Neither has viewing history (or tied) — fall back to whichever
    // gap aired first.
    return a.air_date < b.air_date ? -1 : 1;
  });
}

// Second widget — the opposite of "next premiere": episodes that
// have ALREADY aired but aren't watched yet, i.e. what's sitting
// ready right now. Deliberately NOT using the get_next_episodes()
// RPC here — that function is designed to run under the calling
// user's own session (relying on auth.uid() internally), which the
// backend's own service connection doesn't carry per-request.
//
// Also returns topEpisodeId/topSeasonNumber/topEpisodeNumber now, so
// the widget's "Check-in" button can launch the app with enough
// context to mark that exact episode watched without another round
// trip first (see POST /episodes/:id/rewatch's sibling below for the
// mark-watched call the app makes once it opens).
app.get("/widget/ready-to-watch", requireAuth, asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const readyShows = await getReadyToWatchByShow(req.userId, today);

  if (readyShows.length === 0) return res.json({ hasReady: false, count: 0 });

  const top = readyShows[0];
  // Total READY EPISODES across every tracked show, not the number of
  // shows that happen to have a gap — a show can have several unwatched
  // aired episodes at once (e.g. a whole unwatched season), and the
  // widget's "N episodes ready" text needs to reflect that real total,
  // not be silently capped at 1-per-show.
  const totalReadyEpisodes = readyShows.reduce((sum, s) => sum + s.gapCount, 0);
  res.json({
    hasReady: true,
    count: totalReadyEpisodes,
    topTmdbId: top.shows.tmdb_id,
    topTitle: top.shows.title,
    topPosterPath: top.shows.poster_path,
    topEpisodeId: top.id,
    topSeasonNumber: top.season_number,
    topEpisodeNumber: top.episode_number,
    statusText: totalReadyEpisodes > 1 ? `${totalReadyEpisodes} episodes ready` : "New episode available",
  });
}));

// Third widget — a wide cinematic banner for whichever show is most
// "front of mind" right now: reuses the same earliest-unwatched-aired
// pick as /widget/ready-to-watch (falling back to the soonest-upcoming
// premiere from /widget/next-up's pool if nothing is ready), but adds
// a live TMDB backdrop fetch since `shows` has no backdrop_path column.
app.get("/widget/continue-watching", requireAuth, asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const readyShows = await getReadyToWatchByShow(req.userId, today);
  let pick = readyShows[0];

  if (!pick) {
    // Nothing ready to watch — fall back to the soonest upcoming
    // premiere so the widget still has something cinematic to show.
    const { data: upcomingRows } = await supabase
      .from("episodes")
      .select(`
        id, show_id, season_number, episode_number, air_date,
        shows!inner(id, tmdb_id, title,
          user_watchlist!inner(user_id, status)
        )
      `)
      .gte("air_date", today)
      .eq("shows.user_watchlist.user_id", req.userId)
      .in("shows.user_watchlist.status", ["watching", "up_to_date"])
      .order("air_date", { ascending: true })
      .limit(1);
    pick = (upcomingRows || [])[0];
  }

  if (!pick) return res.json({ hasShow: false });

  let backdropPath = null;
  try {
    backdropPath = await getShowBackdrop(pick.shows.tmdb_id);
  } catch (err) {
    console.error("widget/continue-watching: backdrop fetch failed:", err.message);
  }

  res.json({
    hasShow: true,
    tmdbId: pick.shows.tmdb_id,
    title: pick.shows.title,
    seasonNumber: pick.season_number,
    episodeNumber: pick.episode_number,
    backdropPath,
  });
}));

// Powers the "Watch Next" home-screen LIST widget (multiple shows at
// once, each with a background-markable checkbox) — same underlying
// pick-and-order logic as /widget/ready-to-watch (recency of actual
// viewing first, oldest gap as tiebreaker), just returning the whole
// list instead of only the top one. Capped at 15 rows — plenty for a
// scrollable widget list without ever needing pagination there.
app.get("/widget/watch-next-list", requireAuth, asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const readyShows = await getReadyToWatchByShow(req.userId, today);

  res.json({
    items: readyShows.slice(0, 15).map((r) => ({
      episodeId: r.id,
      tmdbId: r.shows.tmdb_id,
      title: r.shows.title,
      posterPath: r.shows.poster_path,
      seasonNumber: r.season_number,
      episodeNumber: r.episode_number,
    })),
  });
}));

// Powers the "Upcoming Episodes" home-screen LIST widget — the
// soonest still-unaired episode for EACH tracked show, sorted
// chronologically (soonest first). Read-only (no checkbox), so unlike
// getReadyToWatchByShow this doesn't need any watched-status check at
// all — a not-yet-aired episode is never "watched". Queried per show
// for the same reason as getReadyToWatchByShow: a global
// most-recent-N-rows query can silently drop a show whose next
// episode is further out than 15 other shows' nearer ones.
async function getUpcomingByShow(userId, today) {
  const { data: trackedRows, error: trackedErr } = await supabase
    .from("user_watchlist")
    .select("show_id, shows(id, tmdb_id, title, poster_path)")
    .eq("user_id", userId)
    .in("status", ["watching", "up_to_date"]);
  if (trackedErr) throw trackedErr;

  const perShow = await Promise.all(
    (trackedRows || [])
      .filter((tw) => tw.shows)
      .map(async (tw) => {
        const { data: eps, error: epErr } = await supabase
          .from("episodes")
          .select("id, season_number, episode_number, air_date")
          .eq("show_id", tw.show_id)
          .gte("air_date", today)
          .order("air_date", { ascending: true })
          .limit(1);
        if (epErr) throw epErr;
        const next = (eps || [])[0];
        return next ? { ...next, shows: tw.shows } : null;
      })
  );

  return perShow.filter(Boolean).sort((a, b) => (a.air_date < b.air_date ? -1 : 1));
}

app.get("/widget/upcoming-list", requireAuth, asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = await getUpcomingByShow(req.userId, today);

  res.json({
    items: upcoming.slice(0, 15).map((r) => ({
      episodeId: r.id,
      tmdbId: r.shows.tmdb_id,
      title: r.shows.title,
      posterPath: r.shows.poster_path,
      seasonNumber: r.season_number,
      episodeNumber: r.episode_number,
      airDate: r.air_date,
    })),
  });
}));

// Called directly by the native side (a background BroadcastReceiver,
// not the app UI) when the person taps the checkbox on a "Watch Next"
// widget row — marks that one episode watched without ever opening
// the app. Deliberately its own tiny endpoint rather than routing
// through the app's own Supabase-direct write path: the widget only
// carries a bearer access token (via requireAuth, same as every other
// /widget/* route), no live Supabase client/session.
app.post("/widget/mark-watched", requireAuth, asyncHandler(async (req, res) => {
  const { episodeId } = req.body || {};
  if (!episodeId) return res.status(400).json({ error: "episodeId is required" });

  const { error } = await supabase
    .from("watched_episodes")
    .upsert(
      { user_id: req.userId, episode_id: episodeId, source: "manual" },
      { onConflict: "user_id,episode_id" }
    );
  if (error) throw error;

  res.json({ ok: true });
}));

// How long a cached episode list is trusted before we go back to TMDB
// for a still-airing show. Ended/canceled shows never go stale (their
// episode list can't change), so they skip this entirely once synced.
const EPISODE_SYNC_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

app.get("/shows/:tmdbId/full-progress", requireAuth, asyncHandler(async (req, res) => {
  const tmdbId = req.params.tmdbId;

  const { data: showRow } = await supabase
    .from("shows")
    .select("id, status, episodes_synced_at")
    .eq("tmdb_id", tmdbId)
    .single();
  if (!showRow) {
    // Not tracked at all yet — nothing could possibly be marked
    // watched, so there's no gap to detect. (In practice the frontend
    // only calls this once a show is already tracked, since that's
    // the only way to mark an episode watched in the first place.)
    return res.json({ episodes: [], watchedEpisodeIds: [], showStatus: null });
  }

  // Was this show's episode list already synced recently enough to
  // trust as-is? An ended/canceled show's episode list can never
  // change again, so any past sync is good forever. A still-airing
  // show can get new episodes at any time, so we only trust a sync
  // from within the last few hours — this is what turns "every show
  // page open" into 4+ sequential TMDB calls, so skipping it whenever
  // safe is the actual fix for that slowness, not just a workaround.
  const isFinished = showRow.status === "Ended" || showRow.status === "Canceled";
  const syncedRecently = showRow.episodes_synced_at &&
    Date.now() - new Date(showRow.episodes_synced_at).getTime() < EPISODE_SYNC_TTL_MS;
  const canUseCache = showRow.episodes_synced_at && (isFinished || syncedRecently);

  let cached, showStatus;
  if (canUseCache) {
    const { data: existingEpisodes, error: epErr } = await supabase
      .from("episodes")
      .select("id, season_number, episode_number")
      .eq("show_id", showRow.id)
      .order("season_number", { ascending: true })
      .order("episode_number", { ascending: true });
    if (epErr) throw epErr;
    cached = existingEpisodes || [];
    showStatus = showRow.status;
  } else {
    const fetched = await fetchAllEpisodes(tmdbId);
    cached = await cacheEpisodes(supabase, showRow.id, fetched.episodes);
    showStatus = fetched.showStatus;
    await supabase
      .from("shows")
      .update({ status: showStatus, episodes_synced_at: new Date().toISOString() })
      .eq("id", showRow.id);
  }

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

app.post("/friends/request", requireAuth, asyncHandler(async (req, res) => {
  const { email, username } = req.body;
  if (!email && !username) return res.status(400).json({ error: "email or username is required" });
  const target = username ? await findUserByUsername(username) : await findUserByEmail(email);
  const result = await sendFriendRequest(supabase, req.userId, target);
  res.json(result);
}));

// Lets a user pick their own username — used so people can be added
// as a friend without ever sharing their email (e.g. inviting a
// whole online community to "search my username and add me").
// Case-insensitive uniqueness is enforced at the DB level; a 23505
// (unique violation) here means it's already taken.
app.post("/profile/username", requireAuth, asyncHandler(async (req, res) => {
  const { username } = req.body;
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters — letters, numbers, and underscores only." });
  }
  const { error } = await supabase
    .from("user_profiles")
    .upsert({ user_id: req.userId, username }, { onConflict: "user_id" });
  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "That username is already taken." });
    }
    throw error;
  }
  res.json({ ok: true, username });
}));

app.get("/profile/username", requireAuth, asyncHandler(async (req, res) => {
  const { data } = await supabase.from("user_profiles").select("username").eq("user_id", req.userId).maybeSingle();
  res.json({ username: data?.username || null });
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

app.get("/friends", requireAuth, asyncHandler(async (req, res) => {
  const result = await listFriends(supabase, req.userId);
  res.json(result);
}));

app.post("/friends/:id/accept", requireAuth, asyncHandler(async (req, res) => {
  const result = await acceptFriendRequest(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.post("/friends/:id/decline", requireAuth, asyncHandler(async (req, res) => {
  const result = await declineFriendRequest(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.delete("/friends/:id", requireAuth, asyncHandler(async (req, res) => {
  const result = await removeFriend(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.get("/friends/:id/favorites", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await getFriendFavorites(supabase, req.params.id, req.userId);
  res.json(result);
}));

// Messaging between already-accepted friends is free, same tier as
// viewing/managing the friends list — only sending NEW requests and
// viewing favorites are the Pro-gated parts of this feature.
app.get("/friends/:id/messages", requireAuth, asyncHandler(async (req, res) => {
  const result = await getMessages(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.post("/friends/:id/messages", requireAuth, asyncHandler(async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "content is required" });
  const result = await sendMessage(supabase, req.params.id, req.userId, content.trim());
  res.json(result);
}));

app.delete("/messages/:id", requireAuth, asyncHandler(async (req, res) => {
  const result = await deleteMessage(supabase, req.params.id, req.userId);
  res.json(result);
}));

app.post("/ai/chat", requireAuth, aiChatRateLimiter, asyncHandler(async (req, res) => {
  const { message, history = [], locale = "en" } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await supabase
    .from("ai_usage_daily")
    .select("count, bonus_messages")
    .eq("user_id", req.userId)
    .eq("usage_date", today)
    .single();
  const currentCount = usage?.count || 0;
  // Extra allowance earned by watching a rewarded ad — see POST /ai/bonus.
  const bonusMessages = usage?.bonus_messages || 0;
  const pro = await isUserPro(req.userId);

  if (!pro && currentCount >= AI_DAILY_LIMIT + bonusMessages) {
    return res.status(429).json({
      error: "You've reached today's AI chat limit. Try again tomorrow.",
      bonusAvailable: bonusMessages === 0,
    });
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

  const { data: movieWatchlist } = await supabase
    .from("user_movie_watchlist")
    .select("status, movies(title)")
    .eq("user_id", req.userId)
    .limit(120);

  const watchedMovieTitles = (movieWatchlist || [])
    .filter((m) => m.status === "watched")
    .map((m) => m.movies?.title)
    .filter(Boolean);

  // Maps the frontend's locale codes to a plain language name the
  // model can follow reliably — cheaper and more robust than asking
  // it to interpret a raw locale code like "id" or "hi" itself.
  const LOCALE_NAMES = {
    en: "English", es: "Spanish", pt: "Portuguese", de: "German", fr: "French",
    ar: "Arabic", tr: "Turkish", it: "Italian", id: "Indonesian", hi: "Hindi", ru: "Russian",
  };
  const languageName = LOCALE_NAMES[locale] || "English";
  const languageInstruction = languageName === "English" ? "" : ` Respond in ${languageName} — the user's app language is set to ${languageName}, regardless of what language they write their message in.`;

  const systemPrompt = `You are Scenera's TV show and movie recommendation assistant. Give concise, specific recommendations (2-4 titles max per answer, shows and/or movies as fits the request), each with a one-sentence reason tied to the user's taste. Avoid generic disclaimers or long intros — get straight to the recommendations.${languageInstruction}

Do NOT recommend anything in the user's lists below — only suggest titles they haven't already tracked.

User's completed shows: ${completedTitles.slice(0, 80).join(", ") || "none yet"}
User's currently watching shows: ${watchingTitles.slice(0, 40).join(", ") || "none yet"}
User's watched movies: ${watchedMovieTitles.slice(0, 80).join(", ") || "none yet"}`;

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
      const trackedTvTmdbIds = new Set((trackedRows || []).map((r) => r.shows?.tmdb_id).filter(Boolean));

      const { data: trackedMovieRows } = await supabase
        .from("user_movie_watchlist")
        .select("movies(tmdb_id)")
        .eq("user_id", req.userId);
      const trackedMovieTmdbIds = new Set((trackedMovieRows || []).map((r) => r.movies?.tmdb_id).filter(Boolean));

      const structuredSystemPrompt = `You are Scenera's TV show and movie recommendation assistant. Based on the conversation and the user's watch history below, recommend 5-6 titles (shows and/or movies, as fits the request) tied to their taste — more than you'd normally suggest, since some may turn out to already be on the user's list and get filtered out before they're shown.${languageInstruction}${languageName !== "English" ? ` Write the "reason" field in ${languageName}; keep "title" and "type" as-is (an English title lookup key, not translated).` : ""}
Respond ONLY with a JSON object in exactly this shape, no text outside the JSON: {"recommendations": [{"title": "Name", "type": "tv" or "movie", "reason": "one sentence tied to the user's taste"}]}

Try to avoid the user's lists below where it's obvious, but don't spend time meticulously cross-checking every title against them — a separate system already filters out anything already tracked before the person sees it, so a few overlaps here are fine and expected.

User's completed shows: ${completedTitles.slice(0, 80).join(", ") || "none yet"}
User's currently watching shows: ${watchingTitles.slice(0, 40).join(", ") || "none yet"}
User's watched movies: ${watchedMovieTitles.slice(0, 80).join(", ") || "none yet"}`;

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
            const isMovie = rec.type === "movie";
            const results = isMovie ? await searchMovie(rec.title) : await searchShow(rec.title);
            if (!results || results.length === 0) return null;
            const best = results[0];
            const trackedSet = isMovie ? trackedMovieTmdbIds : trackedTvTmdbIds;
            if (trackedSet.has(best.id)) return null;
            return {
              tmdbId: best.id,
              title: isMovie ? best.title : best.name,
              posterPath: best.poster_path || null,
              reason: rec.reason || "",
              mediaType: isMovie ? "movie" : "tv",
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

// Called after the client confirms a rewarded ad was watched to
// completion (AdMob's Rewarded event). Capped at one grant per
// calendar day per user so someone can't just keep replaying ads for
// unlimited free AI chat — this is the same trade-off apps that offer
// "watch an ad for a bonus" always make.
const AI_BONUS_MESSAGES = 3;
app.post("/ai/bonus", requireAuth, asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await supabase
    .from("ai_usage_daily")
    .select("count, bonus_messages")
    .eq("user_id", req.userId)
    .eq("usage_date", today)
    .single();

  if ((usage?.bonus_messages || 0) > 0) {
    return res.status(429).json({ error: "You've already claimed today's bonus messages." });
  }

  const payload = { user_id: req.userId, usage_date: today, bonus_messages: AI_BONUS_MESSAGES };
  if (!usage) payload.count = 0;
  await supabase.from("ai_usage_daily").upsert(payload, { onConflict: "user_id,usage_date" });

  res.json({ ok: true, bonusMessages: AI_BONUS_MESSAGES });
}));

const { sendDailyUpcomingNotifications, checkUpcomingPremieres, sendDailyEngagementNudge, sendPushToUser } = require("./pushNotifications");
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

// Sends a custom, one-off push notification to ONE specific user —
// useful for manual/demo purposes (e.g. testing what a notification
// looks like) without waiting for the automatic daily jobs above.
// Body: { "userId": "...", "title": "...", "body": "...", "imageUrl": "..." (optional) }
app.post("/admin/send-to-user", asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { userId, title, body, imageUrl } = req.body;
  if (!userId || !title || !body) {
    return res.status(400).json({ error: "userId, title, and body are required" });
  }
  const result = await sendPushToUser(supabase, userId, { title, body, imageUrl });
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
