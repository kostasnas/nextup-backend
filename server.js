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
const { parseBingersExport } = require("./bingersParser");
const { parseMovieParadiseExport } = require("./movieParadiseParser");
const { parseSimklExport } = require("./simklParser");
const { parseSofaTimeExport } = require("./sofaTimeParser");
const { parseTraktExport } = require("./traktParser");
const { parseLetterboxdExport } = require("./letterboxdParser");
const { matchShows, searchShow, searchMovie, matchMovie } = require("./tmdbMatcher");
const { syncShowProgress, fetchAllEpisodes, cacheEpisodes } = require("./episodeSync");
const { sendFriendRequest, listFriends, acceptFriendRequest, declineFriendRequest, removeFriend, getFriendFavorites, getFriendWatching } = require("./friends");
const { sendMessage, getMessages, deleteMessage } = require("./messages");
const { getComments, getCommentCountsForShow, addComment, deleteComment, toggleCommentLike, getEpisodeContext } = require("./episodeComments");
const { getMovieWatchlist, setMovieStatus, updateMovieEntry, removeMovie } = require("./movies");
const { getFavoriteCharacters, addFavoriteCharacter, removeFavoriteCharacter, getCharacterVoteCounts } = require("./favoriteCharacters");
const { listFeatureRequests, createFeatureRequest, toggleVote } = require("./featureRequests");
const { logRewatch, removeRewatch, getRewatchCountsForShow } = require("./episodeRewatches");
const { getEmotionCountsForShow } = require("./episodeEmotions");
const { createConnectUrl, handleCallback, disconnectTrakt, getTraktStatus } = require("./traktAuth");
const { syncAllTraktUsers } = require("./traktSync");
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

const { getWatchProviders, getShowWatchProviders, getMovieWatchProviders, getShowBackdrop, getMovieDetails, getTopShows, getTrending, getGenres, getPersonDetails } = require("./discover");
const { getRottenTomatoesRating } = require("./rottenTomatoes");
const { getMovieCommunityRating } = require("./movieRatings");
const { getFriendsActivityFeed, getFriendsSummary } = require("./feed");

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

// Rotten Tomatoes score (via OMDb, see rottenTomatoes.js) — public,
// cached, no auth needed. Always returns 200 with null fields instead
// of erroring when OMDB_API_KEY isn't set or a title has no RT score,
// since this is a nice-to-have badge the rest of Show/Movie Detail
// should never depend on.
app.get("/shows/:id/rotten-tomatoes", asyncHandler(async (req, res) => {
  const result = await getRottenTomatoesRating(req.params.id, "tv");
  res.json(result || { score: null, imdbRating: null, imdbId: null });
}));

app.get("/movies/:id/rotten-tomatoes", asyncHandler(async (req, res) => {
  const result = await getRottenTomatoesRating(req.params.id, "movie");
  res.json(result || { score: null, imdbRating: null, imdbId: null });
}));

// Scenera's own aggregate rating for a movie — public, no auth
// needed, movie-side equivalent of /shows/:id/community-rating above.
app.get("/movies/:id/community-rating", asyncHandler(async (req, res) => {
  const rating = await getMovieCommunityRating(req.params.id);
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

// Public "Emotion Vote" tally — see episodeEmotions.js. Same
// auth-required-but-not-user-scoped convention as comment-counts
// above (the data itself is global, counting every user's reaction).
app.get("/shows/:id/emotion-counts", requireAuth, asyncHandler(async (req, res) => {
  const counts = await getEmotionCountsForShow(req.params.id);
  res.json(counts);
}));

// Trakt OAuth connect flow — "Auto-Tracking (Scrobbling)". See
// traktAuth.js for the full flow explanation.
app.get("/trakt/connect", requireAuth, asyncHandler(async (req, res) => {
  const url = await createConnectUrl(supabase, req.userId);
  res.json({ url });
}));

// Public — Trakt redirects the user's browser straight here with no
// Bearer token available, so this route can't use requireAuth; the
// `state` param (created while the user WAS authenticated, above) is
// what recovers which Scenera user this belongs to. Renders a plain
// HTML page since a real browser lands here, not our app's fetch code.
app.get("/trakt/callback", asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.send(`<html><body style="font-family: sans-serif; text-align:center; padding-top:80px;">
      <h2>Trakt connection cancelled</h2><p>You can close this tab and try again from Scenera.</p></body></html>`);
  }
  try {
    await handleCallback(supabase, code, state);
    res.send(`<html><body style="font-family: sans-serif; text-align:center; padding-top:80px;">
      <h2>✅ Trakt connected!</h2><p>You can close this tab and go back to Scenera.</p></body></html>`);
  } catch (e) {
    console.error("Trakt callback failed:", e.message);
    res.send(`<html><body style="font-family: sans-serif; text-align:center; padding-top:80px;">
      <h2>Something went wrong</h2><p>${e.message}</p><p>You can close this tab and try again from Scenera.</p></body></html>`);
  }
}));

app.get("/trakt/status", requireAuth, asyncHandler(async (req, res) => {
  const status = await getTraktStatus(supabase, req.userId);
  res.json(status);
}));

app.delete("/trakt/connection", requireAuth, asyncHandler(async (req, res) => {
  const result = await disconnectTrakt(supabase, req.userId);
  res.json(result);
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
  const { tmdbPersonId, personName, profilePath, sourceType, sourceTmdbId, sourceTitle, characterName, isAnime, showTitle } = req.body;
  if (!tmdbPersonId || !personName || !sourceType || !sourceTmdbId || !sourceTitle) {
    return res.status(400).json({ error: "tmdbPersonId, personName, sourceType, sourceTmdbId, and sourceTitle are required" });
  }
  const result = await addFavoriteCharacter(supabase, req.userId, { tmdbPersonId, personName, profilePath, sourceType, sourceTmdbId, sourceTitle, characterName, isAnime: !!isAnime, showTitle });
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

// Headline totals for the "Shows · Movies · Hours" stats share card
// (StatsScreen) — "shows" counts distinct shows with at least one
// watched episode (not just added to a list), matching what "hours"
// is actually built from. Aggregated in JS rather than a Postgres
// function, same reasoning as getCharacterVoteCounts above: one
// person's watched_episodes is never large enough for a bespoke RPC
// to be worth it.
app.get("/stats/summary", requireAuth, asyncHandler(async (req, res) => {
  // Used only for the (rare) show where TMDB has never given us an
  // episode_run_time — better to estimate with a typical episode
  // length than to silently under-count that show's hours as zero.
  const DEFAULT_EPISODE_MINUTES = 42;

  const { data: watchedRows, error: watchedErr } = await supabase
    .from("watched_episodes")
    .select("episodes(show_id, shows(avg_episode_runtime))")
    .eq("user_id", req.userId);
  if (watchedErr) throw watchedErr;

  const showIds = new Set();
  let episodeMinutes = 0;
  for (const row of watchedRows || []) {
    const ep = row.episodes;
    if (!ep) continue; // orphaned row (episode/show deleted) — ignore rather than crash
    if (ep.show_id) showIds.add(ep.show_id);
    episodeMinutes += ep.shows?.avg_episode_runtime || DEFAULT_EPISODE_MINUTES;
  }

  const { data: movieRows, error: movieErr } = await supabase
    .from("user_movie_watchlist")
    .select("runtime")
    .eq("user_id", req.userId)
    .eq("status", "watched");
  if (movieErr) throw movieErr;

  const movieMinutes = (movieRows || []).reduce((sum, m) => sum + (m.runtime || 0), 0);
  const totalHours = Math.round((episodeMinutes + movieMinutes) / 60);

  res.json({ showsCount: showIds.size, moviesCount: (movieRows || []).length, totalHours });
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

// Bingers import — unlike TV Time, every row in a Bingers export
// already carries a real tmdb_id, so bingersParser.js hands us shows
// that are pre-matched (show.match.status === "matched" for every
// one of them). That means this skips the whole matchShows() fuzzy
// title-search step entirely: no TMDB search calls, no confidence
// threshold, no import_unmatched review queue for shows. Movies are
// looked up individually by id (getMovieDetails) purely to fill in
// poster/overview — the id itself is already trusted.
async function processBingersImport(userId, files) {
  const { shows, movies, stats } = parseBingersExport(files);
  console.log(
    `Bingers import: ${shows.length} shows (${stats.showsWithEpisodeData} with episode data), ` +
    `${movies.length} movies (${stats.watchedMovies} watched).`
  );

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "bingers", status: "matching", total_records: stats.totalShows })
    .select()
    .single();
  if (jobError) throw jobError;

  let matchedCount = 0;
  for (const show of shows) {
    matchedCount++;
    await upsertShowProgress(userId, show, job.id, {
      // Bingers gives real per-episode dates directly (watches.csv),
      // not just a count — so every show goes through the same exact
      // "episode log" path TV Time only gets for the minority of
      // users whose export happened to include tracking-prod-records-v2.csv.
      episodeLog: show.episodeLog && show.episodeLog.length > 0 ? show.episodeLog : null,
      emotionLog: null,
    });
  }

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const details = await getMovieDetails(movie.tmdbId);
      await setMovieStatus(
        supabase,
        userId,
        {
          tmdb_id: movie.tmdbId,
          title: details.title || movie.title,
          poster_path: details.posterPath,
          release_date: details.releaseDate,
          runtime: details.runtime,
          overview: details.overview,
        },
        movie.isWatched ? "watched" : "planned",
        movie.watchedAt
      );
      movieMatchedCount++;
    } catch (e) {
      console.error(`Bingers import: failed to import movie "${movie.title}" (tmdb_id ${movie.tmdbId}):`, e.message);
      movieUnmatchedCount++;
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: "completed", // no unmatched shows possible — every row already had a tmdb_id
      matched_records: matchedCount,
      unmatched_records: 0,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return {
    jobId: job.id,
    matchedCount,
    unmatchedCount: 0,
    totalShows: stats.totalShows,
    watchingCandidates: stats.showsWithEpisodeData,
    warning: null,
    movieMatchedCount,
    movieUnmatchedCount,
    totalMovies: stats.totalMovies,
  };
}

app.post(
  "/import/bingers",
  requireAuth,
  uploadCsv.fields([
    { name: "library", maxCount: 1 },
    { name: "watches", maxCount: 1 },
    { name: "ratings", maxCount: 1 },
    { name: "lists", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    if (!req.files?.library) {
      return res.status(400).json({ error: "library.csv is required (the file listing your shows and movies)." });
    }
    const files = {};
    for (const [field, arr] of Object.entries(req.files)) {
      files[`${field}.csv`] = arr[0].buffer.toString("utf8");
    }
    const result = await processBingersImport(req.userId, files);
    res.json(result);
  })
);

// Movie Paradise import — reads data.json out of the uploaded zip
// (movieParadiseParser.js ignores the individual CSVs, which just
// restate the same data less conveniently). Same pre-matched-tmdb_id
// shortcut as Bingers. v1 scope only — see movieParadiseParser.js's
// file header for what's NOT imported yet (comments/GIFs, character
// favorites) and why; commentsSkipped/reactionsSkipped are returned
// here so the frontend can show an honest count rather than silently
// dropping them.
async function processMovieParadiseImport(userId, files) {
  const { shows, movies, stats } = parseMovieParadiseExport(files);
  if (stats.error) {
    const e = new Error(stats.error);
    e.status = 400;
    throw e;
  }
  console.log(
    `Movie Paradise import: ${shows.length} shows (${stats.showsWithEpisodeData} with episode data), ` +
    `${movies.length} movies (${stats.watchedMovies} watched). ` +
    `Comments: ${stats.importableComments}/${stats.totalComments} importable (not yet wired up — v1 scope).`
  );

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "movie_paradise", status: "matching", total_records: stats.totalShows })
    .select()
    .single();
  if (jobError) throw jobError;

  let matchedCount = 0;
  for (const show of shows) {
    matchedCount++;
    await upsertShowProgress(userId, show, job.id, {
      episodeLog: show.episodeLog && show.episodeLog.length > 0 ? show.episodeLog : null,
      emotionLog: null,
    });
  }

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const details = await getMovieDetails(movie.tmdbId);
      await setMovieStatus(
        supabase,
        userId,
        {
          tmdb_id: movie.tmdbId,
          title: details.title || movie.title,
          poster_path: details.posterPath,
          release_date: details.releaseDate,
          runtime: details.runtime,
          overview: details.overview,
        },
        movie.isWatched ? "watched" : "planned",
        movie.watchedAt
      );
      movieMatchedCount++;
    } catch (e) {
      console.error(`Movie Paradise import: failed to import movie "${movie.title}" (tmdb_id ${movie.tmdbId}):`, e.message);
      movieUnmatchedCount++;
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      matched_records: matchedCount,
      unmatched_records: 0,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return {
    jobId: job.id,
    matchedCount,
    unmatchedCount: 0,
    totalShows: stats.totalShows,
    watchingCandidates: stats.showsWithEpisodeData,
    warning: null,
    movieMatchedCount,
    movieUnmatchedCount,
    totalMovies: stats.totalMovies,
    commentsNote: stats.totalComments > 0
      ? `${stats.totalComments} comment(s) found in your export but not imported yet — comment/GIF import is still being built.`
      : null,
  };
}

app.post("/import/movie-paradise-zip", requireAuth, uploadZip.single("export_zip"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries();
  const dataEntry = entries.find((e) => e.entryName.toLowerCase().endsWith("data.json"));
  if (!dataEntry) {
    return res.status(400).json({ error: "Could not find data.json inside the uploaded zip. Make sure you uploaded the full Movie Paradise export." });
  }

  const files = { "data.json": dataEntry.getData().toString("utf8") };
  const result = await processMovieParadiseImport(req.userId, files);
  res.json(result);
}));

// Simkl import — same pre-matched-tmdb_id shortcut as Bingers/Movie
// Paradise. Genuine wrinkle handled by simklParser.js, not here: a
// fully "completed" show has no per-episode dates in the export, just
// an aggregate count — episodeLog comes through null for those, and
// upsertShowProgress/syncShowProgress already know to fall back to
// the count-based fill-in in that case (same as every other source).
async function processSimklImport(userId, files) {
  const { shows, movies, stats } = parseSimklExport(files);
  if (stats.error) {
    const e = new Error(stats.error);
    e.status = 400;
    throw e;
  }
  console.log(
    `Simkl import: ${shows.length} shows (${stats.showsWithEpisodeData} with exact episode dates), ` +
    `${movies.length} movies (${stats.watchedMovies} watched).`
  );

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "simkl", status: "matching", total_records: stats.totalShows })
    .select()
    .single();
  if (jobError) throw jobError;

  let matchedCount = 0;
  for (const show of shows) {
    matchedCount++;
    await upsertShowProgress(userId, show, job.id, {
      episodeLog: show.episodeLog,
      emotionLog: null,
    });
  }

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const details = await getMovieDetails(movie.tmdbId);
      await setMovieStatus(
        supabase,
        userId,
        {
          tmdb_id: movie.tmdbId,
          title: details.title || movie.title,
          poster_path: details.posterPath,
          release_date: details.releaseDate,
          runtime: details.runtime,
          overview: details.overview,
        },
        movie.isWatched ? "watched" : "planned",
        movie.watchedAt
      );
      movieMatchedCount++;
    } catch (e) {
      console.error(`Simkl import: failed to import movie "${movie.title}" (tmdb_id ${movie.tmdbId}):`, e.message);
      movieUnmatchedCount++;
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      matched_records: matchedCount,
      unmatched_records: 0,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return {
    jobId: job.id,
    matchedCount,
    unmatchedCount: 0,
    totalShows: stats.totalShows,
    watchingCandidates: stats.showsWithEpisodeData,
    warning: null,
    movieMatchedCount,
    movieUnmatchedCount,
    totalMovies: stats.totalMovies,
  };
}

app.post("/import/simkl-zip", requireAuth, uploadZip.single("export_zip"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries();
  const dataEntry = entries.find((e) => e.entryName.toLowerCase().endsWith("simklbackup.json"));
  if (!dataEntry) {
    return res.status(400).json({ error: "Could not find SimklBackup.json inside the uploaded zip. Make sure you uploaded the file from simkl.com/apps/backup's \"DOWNLOAD BACKUP\" button (not the CSV option)." });
  }

  const files = { "SimklBackup.json": dataEntry.getData().toString("utf8") };
  const result = await processSimklImport(req.userId, files);
  res.json(result);
}));

// Sofa Time's export is 6 JSON files inside a zip, each named with a
// timestamp suffix that varies per export (e.g.
// "watchlistShow_(2026_09_29_14_08_28).json") — matched here by prefix
// rather than exact name, then remapped to the canonical keys
// sofaTimeParser.js expects.
const SOFA_TIME_FILE_PREFIXES = {
  "watchlistShow.json": "watchlistshow",
  "watchedShow.json": "watchedshow",
  "stopWatchingShow.json": "stopwatchingshow",
  "watchlistMovie.json": "watchlistmovie",
  "watchedMovie.json": "watchedmovie",
  "stopWatchingMovie.json": "stopwatchingmovie",
};

async function processSofaTimeImport(userId, files) {
  const { shows, movies, stats } = parseSofaTimeExport(files);
  if (stats.error) {
    const e = new Error(stats.error);
    e.status = 400;
    throw e;
  }
  console.log(
    `Sofa Time import: ${shows.length} shows (${stats.showsWithEpisodeData} with exact episode dates), ` +
    `${movies.length} movies (${stats.watchedMovies} watched).`
  );

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "sofa_time", status: "matching", total_records: stats.totalShows })
    .select()
    .single();
  if (jobError) throw jobError;

  let matchedCount = 0;
  for (const show of shows) {
    matchedCount++;
    await upsertShowProgress(userId, show, job.id, {
      episodeLog: show.episodeLog,
      emotionLog: null,
    });
  }

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const details = await getMovieDetails(movie.tmdbId);
      await setMovieStatus(
        supabase,
        userId,
        {
          tmdb_id: movie.tmdbId,
          title: details.title || movie.title,
          poster_path: details.posterPath,
          release_date: details.releaseDate,
          runtime: details.runtime,
          overview: details.overview,
        },
        movie.isWatched ? "watched" : "planned",
        movie.watchedAt
      );
      movieMatchedCount++;
    } catch (e) {
      console.error(`Sofa Time import: failed to import movie "${movie.title}" (tmdb_id ${movie.tmdbId}):`, e.message);
      movieUnmatchedCount++;
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      matched_records: matchedCount,
      unmatched_records: 0,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return {
    jobId: job.id,
    matchedCount,
    unmatchedCount: 0,
    totalShows: stats.totalShows,
    watchingCandidates: stats.showsWithEpisodeData,
    warning: null,
    movieMatchedCount,
    movieUnmatchedCount,
    totalMovies: stats.totalMovies,
  };
}

app.post("/import/sofatime-zip", requireAuth, uploadZip.single("export_zip"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries();

  const files = {};
  const missing = [];
  for (const [canonicalName, prefix] of Object.entries(SOFA_TIME_FILE_PREFIXES)) {
    const entry = entries.find((e) => {
      const base = e.entryName.split("/").pop().toLowerCase();
      return base.startsWith(prefix);
    });
    if (entry) {
      files[canonicalName] = entry.getData().toString("utf8");
    } else {
      missing.push(canonicalName);
    }
  }
  if (missing.length > 0) {
    return res.status(400).json({ error: `Could not find ${missing.join(", ")} inside the uploaded zip. Make sure you uploaded the full Sofa Time export (all 6 files).` });
  }

  const result = await processSofaTimeImport(req.userId, files);
  res.json(result);
}));

// Trakt's export is a big zip of ~40 JSON files with fixed names (no
// timestamp suffix, unlike Sofa Time) — only a handful are used, matched
// by exact name.
const TRAKT_REQUIRED_FILES = ["watched-shows.json", "watched-history.json"];
const TRAKT_OPTIONAL_FILES = ["watched-movies.json", "ratings-shows.json", "ratings-movies.json", "lists-favorites.json", "lists-watchlist.json"];

async function processTraktImport(userId, files) {
  const { shows, movies, stats } = parseTraktExport(files);
  if (stats.error) {
    const e = new Error(stats.error);
    e.status = 400;
    throw e;
  }
  console.log(
    `Trakt import: ${shows.length} shows (${stats.showsWithEpisodeData} with exact episode dates), ` +
    `${movies.length} movies (${stats.watchedMovies} watched).`
  );

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "trakt", status: "matching", total_records: stats.totalShows })
    .select()
    .single();
  if (jobError) throw jobError;

  let matchedCount = 0;
  for (const show of shows) {
    matchedCount++;
    await upsertShowProgress(userId, show, job.id, {
      episodeLog: show.episodeLog,
      emotionLog: null,
    });
  }

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const details = await getMovieDetails(movie.tmdbId);
      await setMovieStatus(
        supabase,
        userId,
        {
          tmdb_id: movie.tmdbId,
          title: details.title || movie.title,
          poster_path: details.posterPath,
          release_date: details.releaseDate,
          runtime: details.runtime,
          overview: details.overview,
        },
        movie.isWatched ? "watched" : "planned",
        movie.watchedAt
      );
      movieMatchedCount++;
    } catch (e) {
      console.error(`Trakt import: failed to import movie "${movie.title}" (tmdb_id ${movie.tmdbId}):`, e.message);
      movieUnmatchedCount++;
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      matched_records: matchedCount,
      unmatched_records: 0,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return {
    jobId: job.id,
    matchedCount,
    unmatchedCount: 0,
    totalShows: stats.totalShows,
    watchingCandidates: stats.showsWithEpisodeData,
    warning: null,
    movieMatchedCount,
    movieUnmatchedCount,
    totalMovies: stats.totalMovies,
  };
}

app.post("/import/trakt-zip", requireAuth, uploadZip.single("export_zip"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries();

  const files = {};
  const missing = [];
  for (const name of TRAKT_REQUIRED_FILES) {
    const entry = entries.find((e) => e.entryName.split("/").pop().toLowerCase() === name);
    if (entry) files[name] = entry.getData().toString("utf8");
    else missing.push(name);
  }
  if (missing.length > 0) {
    return res.status(400).json({ error: `Could not find ${missing.join(", ")} inside the uploaded zip. Make sure you uploaded the full Trakt data export.` });
  }
  for (const name of TRAKT_OPTIONAL_FILES) {
    const entry = entries.find((e) => e.entryName.split("/").pop().toLowerCase() === name);
    if (entry) files[name] = entry.getData().toString("utf8");
  }

  const result = await processTraktImport(req.userId, files);
  res.json(result);
}));

// Letterboxd's export is a fixed folder layout (no timestamp suffixes
// like Sofa Time, no risk of the wrong file if matched by exact
// relative path rather than basename alone — deleted/diary.csv and
// orphaned/diary.csv share a basename with the real diary.csv this
// needs). diary.csv/watched.csv/ratings.csv are all optional
// individually (parser falls back gracefully — see letterboxdParser.js),
// but at least one of diary.csv/watched.csv is required or there's
// nothing to import.
const LETTERBOXD_FILES = ["diary.csv", "watched.csv", "watchlist.csv", "ratings.csv", "likes/films.csv"];

async function processLetterboxdImport(userId, files) {
  const { movies, stats } = parseLetterboxdExport(files);

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ user_id: userId, source: "letterboxd", status: "matching", total_records: stats.totalMovies })
    .select()
    .single();
  if (jobError) throw jobError;

  let movieMatchedCount = 0;
  let movieUnmatchedCount = 0;
  for (const movie of movies) {
    try {
      const match = await matchMovie(movie.title, movie.year);
      if (match.status !== "matched") { movieUnmatchedCount++; continue; }
      const details = await getMovieDetails(match.tmdbId);
      await setMovieStatus(
        supabase,
        userId,
        { tmdb_id: details.id, title: details.title, poster_path: details.poster_path, release_date: details.release_date, runtime: details.runtime, overview: details.overview },
        movie.isWatched ? "watched" : "planned",
        movie.watchedAt
      );
      movieMatchedCount++;
    } catch (e) {
      console.error(`Letterboxd import: failed to match/import "${movie.title}" (${movie.year}):`, e.message);
      movieUnmatchedCount++;
    }
  }

  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      matched_records: movieMatchedCount,
      unmatched_records: movieUnmatchedCount,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return {
    jobId: job.id,
    matchedCount: 0,
    unmatchedCount: 0,
    totalShows: 0,
    watchingCandidates: 0,
    // Letterboxd is films-only — nothing to say about shows, but the
    // ratings/likes caveat (see letterboxdParser.js header) is worth
    // surfacing to the person rather than silently dropping their data.
    warning: (stats.ratingsSkipped > 0 || stats.likesSkipped > 0)
      ? `Star ratings and likes aren't imported yet (${stats.ratingsSkipped} rating(s), ${stats.likesSkipped} like(s) found in your export) — your watched films and watchlist were imported normally.`
      : null,
    movieMatchedCount,
    movieUnmatchedCount,
    totalMovies: stats.totalMovies,
  };
}

app.post("/import/letterboxd-zip", requireAuth, uploadZip.single("export_zip"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "export_zip file is required" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries();

  const files = {};
  for (const name of LETTERBOXD_FILES) {
    const entry = entries.find((e) => e.entryName.toLowerCase().replace(/\\/g, "/") === name);
    if (entry) files[name] = entry.getData().toString("utf8");
  }
  if (!files["diary.csv"] && !files["watched.csv"]) {
    return res.status(400).json({ error: "Could not find diary.csv or watched.csv inside the uploaded zip. Make sure you uploaded the full Letterboxd data export (Settings → Data → Export Your Data)." });
  }

  const result = await processLetterboxdImport(req.userId, files);
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

// Shared by /widget/continue-watching and /widget/watch-next-list: the
// earliest already-aired, unwatched episode for EACH show the user is
// actively tracking, one row per show, already sorted (recency of
// actual viewing first, then earliest gap air date as tiebreak — see
// the SQL function's ORDER BY for the exact rule).
//
// This used to be N+1 JS-side queries (2 round trips PER tracked
// show, all fired in parallel via Promise.all) — for someone tracking
// dozens of shows, that's 100+ simultaneous requests to Supabase on
// every single widget refresh, across 2-3 widgets calling this
// independently near-simultaneously on every app open. That pattern
// amplified a routine Supabase slowdown into an outage-feeling one for
// the user (see the Sept 28 incident) and would only get worse as the
// user base grows, so it's now a single call to a Postgres function
// (get_ready_to_watch_by_show, defined directly in Supabase) that does
// the same work — matching gap-selection and sort logic — in one
// round trip no matter how many shows are tracked.
async function getReadyToWatchByShow(userId, today) {
  const { data, error } = await supabase.rpc("get_ready_to_watch_by_show", {
    p_user_id: userId,
    p_today: today,
  });
  if (error) throw error;

  return (data || []).map((row) => ({
    id: row.episode_id,
    show_id: row.show_id,
    season_number: row.season_number,
    episode_number: row.episode_number,
    air_date: row.air_date,
    shows: {
      id: row.show_id,
      tmdb_id: row.tmdb_id,
      title: row.title,
      poster_path: row.poster_path,
    },
    lastWatchedAt: row.last_watched_at,
    gapCount: row.gap_count,
  }));
}

// Second widget — "Poster Clock": a decorative live clock overlaid on
// a full-bleed backdrop from one of the user's tracked shows, picked
// once per calendar day (stable all day, changes tomorrow) from
// everything in "watching"/"up_to_date" status. This replaces the old
// "Ready to Watch" widget (episodes ready to check in) — that concept
// kept surfacing confusing numbers (backlog shows with huge unwatched
// counts mixed in with genuinely new episodes) and was dropped
// entirely rather than patched again; this widget carries no
// episode-readiness logic at all, it's purely "your shows, on your
// home screen". getReadyToWatchByShow() below is still used by the
// Continue Watching and Watch Next widgets — only this endpoint changed.
app.get("/widget/poster-clock", requireAuth, asyncHandler(async (req, res) => {
  const { data: trackedRows, error: trackedErr } = await supabase
    .from("user_watchlist")
    .select("shows(id, tmdb_id, title, poster_path)")
    .eq("user_id", req.userId)
    .in("status", ["watching", "up_to_date"]);
  if (trackedErr) throw trackedErr;

  const shows = (trackedRows || []).map((r) => r.shows).filter(Boolean);
  if (shows.length === 0) return res.json({ hasShow: false });

  // Deterministic pick that's stable for the whole day (so the widget
  // doesn't change show on every periodic refresh) but rotates daily —
  // a simple string hash of today's date + user id, modulo the
  // tracked-shows count. Doesn't need to be cryptographically random,
  // just evenly spread and reproducible within the same day.
  const today = new Date().toISOString().slice(0, 10);
  const seed = `${req.userId}-${today}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const pick = shows[hash % shows.length];

  // Not every TMDB show has a backdrop_path (some have none at all),
  // and the fetch itself can fail transiently. Either way the widget
  // shouldn't render as a bare black box — fall back to the show's
  // poster (already stored locally, no extra TMDB call) so there's
  // always something behind the clock.
  let backdropPath = null;
  try {
    backdropPath = await getShowBackdrop(pick.tmdb_id);
  } catch (err) {
    console.error("widget/poster-clock: backdrop fetch failed:", err.message);
    Sentry.captureException(err, { tags: { widget: "poster-clock" } });
  }

  res.json({
    hasShow: true,
    tmdbId: pick.tmdb_id,
    title: pick.title,
    backdropPath,
    posterPath: pick.poster_path || null,
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
  // from within the last few hours.
  const isFinished = showRow.status === "Ended" || showRow.status === "Canceled";
  const syncedRecently = showRow.episodes_synced_at &&
    Date.now() - new Date(showRow.episodes_synced_at).getTime() < EPISODE_SYNC_TTL_MS;
  const neverSynced = !showRow.episodes_synced_at;

  let cached, showStatus;
  if (neverSynced) {
    // Nothing cached at all yet for this show, for ANY user — there's
    // no stale-but-usable data to fall back on, so this one request
    // has to actually wait on TMDB. Every other view of this same show,
    // by this user or anyone else, benefits from the cache this writes.
    const fetched = await fetchAllEpisodes(tmdbId);
    cached = await cacheEpisodes(supabase, showRow.id, fetched.episodes);
    showStatus = fetched.showStatus;
    await supabase
      .from("shows")
      .update({ status: showStatus, episodes_synced_at: new Date().toISOString(), avg_episode_runtime: fetched.episodeRunTime })
      .eq("id", showRow.id);
  } else {
    // We have SOMETHING cached — serve it immediately even if stale,
    // so the person never waits on TMDB for a show that's already
    // been synced once. If it's due for a refresh (still-airing show
    // past the TTL), kick that off in the background: it updates the
    // cache for next time but never blocks this response.
    const { data: existingEpisodes, error: epErr } = await supabase
      .from("episodes")
      .select("id, season_number, episode_number")
      .eq("show_id", showRow.id)
      .order("season_number", { ascending: true })
      .order("episode_number", { ascending: true });
    if (epErr) throw epErr;
    cached = existingEpisodes || [];
    showStatus = showRow.status;

    if (!isFinished && !syncedRecently) {
      fetchAllEpisodes(tmdbId)
        .then(async (fetched) => {
          await cacheEpisodes(supabase, showRow.id, fetched.episodes);
          await supabase
            .from("shows")
            .update({ status: fetched.showStatus, episodes_synced_at: new Date().toISOString(), avg_episode_runtime: fetched.episodeRunTime })
            .eq("id", showRow.id);
        })
        .catch((err) => console.error(`Background episode sync failed for tmdbId=${tmdbId}:`, err.message));
    }
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

// Friends Activity Feed v1 (see feed.js) — recent episode/movie
// watches from this user's accepted friends, newest first. Kept for
// now but no longer used by the client, which moved to the grouped
// /feed/friends view below (a flat feed doesn't scale past a
// handful of friends).
app.get("/feed", requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const events = await getFriendsActivityFeed(supabase, req.userId, limit);
  res.json(events);
}));

// Activity Feed v2 — one row per friend (name, avatar, most recent
// watch time), sorted by recency. The client drills into a friend's
// own shows via /friends/:id/watching below.
app.get("/feed/friends", requireAuth, asyncHandler(async (req, res) => {
  const summary = await getFriendsSummary(supabase, req.userId);
  res.json(summary);
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

// Shows a friend has watched, with episode-watched count and their
// most recent episode per show — backs the Activity Feed's per-friend
// drill-down (see getFriendWatching in friends.js).
app.get("/friends/:id/watching", requireAuth, requireFriendsFeature, asyncHandler(async (req, res) => {
  const result = await getFriendWatching(supabase, req.params.id, req.userId);
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

// Trakt auto-tracking sync — pulls new watch history for every
// connected user since their last sync and applies it (see
// traktSync.js). Same shared-secret cron pattern as the other
// scheduled maintenance endpoints above; meant to run every hour or
// so once a scheduler is pointed at it.
const traktSyncHandler = asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const results = await syncAllTraktUsers(supabase);
  res.json({ results });
});
app.get("/trakt/sync-all", traktSyncHandler);
app.post("/trakt/sync-all", traktSyncHandler);
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

// One-time catch-up for shows tracked before avg_episode_runtime
// existed (see the "Hours watched" stats work) — new shows and any
// show whose episodes get re-synced pick this up automatically (see
// fetchAllEpisodes call sites above), but an already-synced, finished
// show never gets re-synced on its own, so it would otherwise be
// stuck with avg_episode_runtime = null forever. Safe to call more
// than once: it only ever targets rows that are still null, and does
// nothing once every show has a value (or TMDB genuinely has none for
// it, in which case it's silently skipped and stays null).
const backfillRuntimesHandler = asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { data: showsMissingRuntime, error } = await supabase
    .from("shows")
    .select("id, tmdb_id")
    .is("avg_episode_runtime", null);
  if (error) throw error;

  let updated = 0;
  let failed = 0;
  for (const show of showsMissingRuntime || []) {
    try {
      const fetched = await fetchAllEpisodes(show.tmdb_id);
      if (fetched.episodeRunTime != null) {
        await supabase.from("shows").update({ avg_episode_runtime: fetched.episodeRunTime }).eq("id", show.id);
        updated++;
      }
    } catch (err) {
      failed++;
      console.error(`Runtime backfill failed for show tmdb_id=${show.tmdb_id}:`, err.message);
    }
  }
  res.json({ checked: (showsMissingRuntime || []).length, updated, failed });
});
app.get("/admin/backfill-episode-runtimes", backfillRuntimesHandler);
app.post("/admin/backfill-episode-runtimes", backfillRuntimesHandler);

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

// One-off "welcome to Scenera" push notification (device push only)
// to everyone who signed up in the last N days (default 3). Manual
// trigger, not on a schedule — see welcomeMessages.js.
// Body: { "days": 3 } (optional)
const { sendWelcomeMessages } = require("./welcomeMessages");
app.post("/admin/send-welcome", asyncHandler(async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const days = req.body?.days || 3;
  const result = await sendWelcomeMessages(supabase, { days });
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
