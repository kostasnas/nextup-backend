// scenes.js
// "Scenes": TMDB stills of an episode (or backdrops of a movie) that a person can attach to a comment,
// the way TV Time's comment images worked.
//
// LOCKED to the developer account until TMDB has answered whether its images may be used this way:
// every route answers 403 for anyone else, and /scenes/status tells the app whether to show the button.
// Nothing is stored: the app attaches TMDB's own image URL, and the list is cached in memory for a while.
const { throttle } = require("./tmdbThrottle");

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SCENES = 40;
const cache = new Map(); // key -> { at, scenes }

const adminId = () => process.env.ADMIN_USER_ID || "47d65eeb-e49b-4854-a5e4-64b468541886";

async function tmdbFetch(path) {
  return throttle(async () => {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) throw new Error("TMDB_API_KEY is not set in environment");
    const res = await fetch(`${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey}`);
    if (!res.ok) throw new Error(`TMDB fetch failed (${res.status}): ${path}`);
    return res.json();
  });
}

// Image list -> what the app needs. Best-rated first; textless images before ones with a language
// printed on them (titles/logos), since a scene is what people want to attach.
function shape(list) {
  const items = (Array.isArray(list) ? list : []).filter((i) => i && typeof i.file_path === "string");
  items.sort((a, b) => {
    const textA = a.iso_639_1 ? 1 : 0;
    const textB = b.iso_639_1 ? 1 : 0;
    if (textA !== textB) return textA - textB;
    return (b.vote_average || 0) - (a.vote_average || 0);
  });
  return items.slice(0, MAX_SCENES).map((i) => ({
    id: i.file_path,
    url: `${IMG_BASE}/w780${i.file_path}`,
    previewUrl: `${IMG_BASE}/w300${i.file_path}`,
    width: i.width || null,
    height: i.height || null,
  }));
}

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.scenes;
  const scenes = await load();
  cache.set(key, { at: Date.now(), scenes });
  if (cache.size > 500) cache.delete(cache.keys().next().value); // keep memory bounded
  return scenes;
}

function mountScenes(app, { supabase, requireAuth, asyncHandler }) {
  const onlyDeveloper = (req, res) => {
    if (req.userId === adminId()) return true;
    res.status(403).json({ error: "Not available" });
    return false;
  };

  app.get("/scenes/status", requireAuth, (req, res) => {
    res.json({ enabled: req.userId === adminId() });
  });

  // Stills of one episode. `:id` is our own episodes.id (what the comments screen already has).
  app.get("/episodes/:id/scenes", requireAuth, asyncHandler(async (req, res) => {
    if (!onlyDeveloper(req, res)) return;
    const { data: ep, error } = await supabase
      .from("episodes")
      .select("season_number, episode_number, shows(tmdb_id)")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) throw error;
    const showTmdbId = ep?.shows?.tmdb_id;
    if (!ep || !showTmdbId) return res.status(404).json({ error: "Episode not found" });
    const key = `ep:${showTmdbId}:${ep.season_number}:${ep.episode_number}`;
    const scenes = await cached(key, async () => {
      const data = await tmdbFetch(`/tv/${showTmdbId}/season/${ep.season_number}/episode/${ep.episode_number}/images`);
      return shape(data.stills);
    });
    res.json({ scenes, source: "episode" });
  }));

  // A movie has no per-scene stills on TMDB, only backdrops, so those are what is offered.
  app.get("/movies/:tmdbId/scenes", requireAuth, asyncHandler(async (req, res) => {
    if (!onlyDeveloper(req, res)) return;
    const tmdbId = Number(req.params.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return res.status(400).json({ error: "Bad movie id" });
    const scenes = await cached(`movie:${tmdbId}`, async () => {
      const data = await tmdbFetch(`/movie/${tmdbId}/images?include_image_language=null`);
      return shape(data.backdrops);
    });
    res.json({ scenes, source: "movie" });
  }));
}

module.exports = { mountScenes, shape };
