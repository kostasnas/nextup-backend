// traktSync.js
// Pulls new watch history from Trakt for a connected user and applies
// it to Scenera's own tables — the actual "Auto-Tracking" effect once
// traktAuth.js's connection exists. Stremio -> Trakt -> here: whatever
// Stremio scrobbled to Trakt shows up in Trakt's own history endpoints,
// which this just polls.
//
// Reuses the same exact-date episode-marking mechanism syncShowProgress
// already has (built originally for TV Time import): we build an
// episodeLog array from Trakt's history instead of a TV Time export
// file, and pass episodesSeenCount: 0 since every watch here has a
// real date already — no "first N episodes" fallback needed.
//
// Movies are simpler — Trakt gives a flat watched_at per movie, which
// maps directly onto movies.js's setMovieStatus(..., "watched",
// watchedAt), the same helper the rest of the app already uses.

const { refreshTokenIfNeeded, getClientId } = require("./traktAuth");
const { syncShowProgress } = require("./episodeSync");
const { setMovieStatus } = require("./movies");
const { getShowDetails } = require("./tmdbMatcher");
const { getMovieDetails } = require("./discover");

const TRAKT_BASE = "https://api.trakt.tv";

function traktHeaders(accessToken) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": getClientId(),
    Authorization: `Bearer ${accessToken}`,
    // Same Cloudflare bot-detection issue as auth.trakt.tv's /oauth/token
    // (see traktAuth.js) — api.trakt.tv sits behind it too, and blocked
    // this exact history fetch with a 403 until a browser-style
    // User-Agent was added.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
}

/**
 * Fetches every page of a Trakt /sync/history/<type> endpoint, newer
 * than `startAt` (omitted on a user's first sync — Trakt then returns
 * their full history). Trakt caps pages at 1000 items each; most
 * accounts never come close, but a first sync on a heavy user could,
 * hence the pagination loop rather than assuming one page is enough.
 */
async function fetchHistory(accessToken, type, startAt) {
  const items = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ limit: "1000", page: String(page) });
    if (startAt) params.set("start_at", startAt);
    const res = await fetch(`${TRAKT_BASE}/sync/history/${type}?${params}`, { headers: traktHeaders(accessToken) });
    if (!res.ok) throw new Error(`Trakt ${type} history fetch failed (${res.status})`);
    const batch = await res.json();
    items.push(...batch);
    const pageCount = parseInt(res.headers.get("x-pagination-page-count") || "1", 10);
    if (page >= pageCount || batch.length === 0) break;
    page++;
  }
  return items;
}

/**
 * Lighter get-or-create than server.js's job-based upsertShowProgress
 * (no import_job_shows logging — there's no import job here, just a
 * live sync). Poster is only fetched from TMDB on first creation.
 */
async function getOrCreateShowRow(supabase, tmdbId, title) {
  const { data: existing } = await supabase.from("shows").select("id").eq("tmdb_id", tmdbId).maybeSingle();
  if (existing) return existing.id;

  let posterPath = null;
  try {
    const details = await getShowDetails(tmdbId);
    posterPath = details.poster_path || null;
  } catch (e) {
    console.error(`Trakt sync: couldn't fetch TMDB details for show ${tmdbId}:`, e.message);
  }

  const { data: inserted, error } = await supabase
    .from("shows")
    .insert({ tmdb_id: tmdbId, title, poster_path: posterPath })
    .select("id")
    .single();
  if (error) throw error;
  return inserted.id;
}

/**
 * setMovieStatus's upsertMovie only fills in poster_path/release_date/
 * runtime/overview from whatever's passed in — it doesn't fetch TMDB
 * itself. Previously this call site only passed {tmdb_id, title}, so
 * any movie first created via Trakt sync got a blank poster forever
 * (4 Οκτ 2026: Kostas found exactly this — two Trakt-synced movies
 * with no poster). Mirrors getOrCreateShowRow above: only hits TMDB
 * when the movie doesn't already exist, since upsertMovie ignores the
 * extra fields for a row that's already there anyway.
 */
async function movieUpsertFields(supabase, tmdbId, title) {
  const { data: existing } = await supabase.from("movies").select("id").eq("tmdb_id", tmdbId).maybeSingle();
  if (existing) return { tmdb_id: tmdbId, title };

  try {
    const details = await getMovieDetails(tmdbId);
    return {
      tmdb_id: tmdbId,
      title: details.title || title,
      poster_path: details.posterPath || null,
      release_date: details.releaseDate || null,
      runtime: details.runtime || null,
      overview: details.overview || null,
    };
  } catch (e) {
    console.error(`Trakt sync: couldn't fetch TMDB details for movie ${tmdbId}:`, e.message);
    return { tmdb_id: tmdbId, title };
  }
}

/**
 * A show watched via Trakt should read as "watching" (or better) in
 * Scenera, not sit at "planned" — only touches a pre-existing row
 * when it's still at that zero-progress default, so a show the user
 * already dropped on purpose stays dropped.
 */
async function ensureWatchlistRow(supabase, userId, showRowId) {
  const { data: existing } = await supabase
    .from("user_watchlist")
    .select("status")
    .eq("user_id", userId)
    .eq("show_id", showRowId)
    .maybeSingle();

  if (!existing) {
    await supabase.from("user_watchlist").insert({ user_id: userId, show_id: showRowId, status: "watching", updated_at: new Date().toISOString() });
  } else if (existing.status === "planned") {
    await supabase.from("user_watchlist").update({ status: "watching", updated_at: new Date().toISOString() }).eq("user_id", userId).eq("show_id", showRowId);
  }
}

/**
 * Runs a full sync for one connected user: refresh the token if
 * needed, pull new episode + movie history since last_synced_at, and
 * apply it. Safe to call repeatedly — everything downstream
 * (applyEpisodeLog, setMovieStatus) is itself idempotent/upsert-based.
 */
async function syncUserTrakt(supabase, connection) {
  connection = await refreshTokenIfNeeded(supabase, connection);
  const startAt = connection.last_synced_at || null;

  const [episodeHistory, movieHistory] = await Promise.all([
    fetchHistory(connection.access_token, "episodes", startAt),
    fetchHistory(connection.access_token, "movies", startAt),
  ]);

  // Group episode watches by show tmdb id — same { season, episode,
  // watchedAt } shape traktParser.js and syncShowProgress already use.
  const episodeLogByShowTmdbId = {};
  const titleByShowTmdbId = {};
  for (const entry of episodeHistory) {
    const showTmdbId = entry.show?.ids?.tmdb;
    const season = entry.episode?.season;
    const episode = entry.episode?.number;
    if (!showTmdbId || season == null || episode == null) continue;
    if (!episodeLogByShowTmdbId[showTmdbId]) episodeLogByShowTmdbId[showTmdbId] = [];
    episodeLogByShowTmdbId[showTmdbId].push({ season, episode, watchedAt: entry.watched_at });
    titleByShowTmdbId[showTmdbId] = entry.show.title;
  }

  let showsSynced = 0;
  let episodesMarked = 0;
  for (const [showTmdbIdStr, episodeLog] of Object.entries(episodeLogByShowTmdbId)) {
    const showTmdbId = parseInt(showTmdbIdStr, 10);
    const showRowId = await getOrCreateShowRow(supabase, showTmdbId, titleByShowTmdbId[showTmdbId]);
    await ensureWatchlistRow(supabase, connection.user_id, showRowId);
    const result = await syncShowProgress(supabase, {
      userId: connection.user_id,
      showRowId,
      tmdbId: showTmdbId,
      episodesSeenCount: 0, // exact dates come from episodeLog — no count-based fallback needed
      episodeLog,
      source: "trakt_sync",
    });
    showsSynced++;
    episodesMarked += result.markedCount;
  }

  let moviesSynced = 0;
  for (const entry of movieHistory) {
    const tmdbId = entry.movie?.ids?.tmdb;
    const title = entry.movie?.title;
    if (!tmdbId || !title) continue;
    await setMovieStatus(supabase, connection.user_id, await movieUpsertFields(supabase, tmdbId, title), "watched", entry.watched_at);
    moviesSynced++;
  }

  await supabase.from("trakt_connections").update({ last_synced_at: new Date().toISOString() }).eq("user_id", connection.user_id);

  return { showsSynced, episodesMarked, moviesSynced };
}

/**
 * Entry point for the admin sync endpoint — runs every connected user
 * one at a time (small enough user base that parallelizing isn't
 * worth the added complexity yet). One user's failure doesn't stop
 * the rest from syncing.
 */
async function syncAllTraktUsers(supabase) {
  const { data: connections, error } = await supabase.from("trakt_connections").select("*");
  if (error) throw error;

  const results = [];
  for (const connection of connections || []) {
    try {
      const result = await syncUserTrakt(supabase, connection);
      results.push({ userId: connection.user_id, ok: true, ...result });
    } catch (e) {
      console.error(`Trakt sync failed for user ${connection.user_id}:`, e.message);
      results.push({ userId: connection.user_id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { syncUserTrakt, syncAllTraktUsers };
