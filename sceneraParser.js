// sceneraParser.js
// Reads a zip produced by Scenera's own "Export my data" (see accountExport.js):
// scenera-export.json holds everything. Rows already carry the TMDB id, so
// nothing needs title matching. Returns shows (with episode + reaction logs)
// and movies in the shape processSceneraImport expects.
const AdmZip = require("adm-zip");

function parseSceneraZip(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    const err = new Error("This does not look like a zip file.");
    err.status = 400;
    throw err;
  }
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith("scenera-export.json"));
  if (!entry) {
    const err = new Error("Could not find scenera-export.json inside the zip. Upload the zip you got from Scenera's \"Export my data\".");
    err.status = 400;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(entry.getData().toString("utf8"));
  } catch {
    const err = new Error("scenera-export.json is not valid JSON.");
    err.status = 400;
    throw err;
  }
  if (data.format !== "scenera-export") {
    const err = new Error("This file is not a Scenera export.");
    err.status = 400;
    throw err;
  }

  const showsByTmdb = new Map();
  for (const w of data.watchlist || []) {
    const tmdbId = Number(w.tmdb_id);
    if (!tmdbId) continue;
    showsByTmdb.set(tmdbId, {
      title: w.show || `TMDB ${tmdbId}`,
      tmdbId,
      status: w.status || "watching",
      rating: w.rating ?? null,
      isFavorite: w.favorite === true,
      episodeLog: [],
      emotionLog: [],
    });
  }
  for (const e of data.watched_episodes || []) {
    const show = showsByTmdb.get(Number(e.tmdb_id));
    if (!show || e.season == null || e.episode == null) continue;
    show.episodeLog.push({ season: e.season, episode: e.episode, watchedAt: e.watched_at || null });
    if (e.reaction) show.emotionLog.push({ season: e.season, episode: e.episode, reaction: e.reaction });
  }

  const movies = [];
  for (const m of data.movies || []) {
    const tmdbId = Number(m.tmdb_id);
    if (!tmdbId) continue;
    movies.push({
      tmdbId,
      title: m.movie || `TMDB ${tmdbId}`,
      status: m.status || "planned",
      rating: m.rating ?? null,
      watchedAt: m.watched_at || null,
    });
  }

  // Second-phase data (needs the episodes cached first — see /import/scenera-extras).
  const rewatches = (data.episode_rewatches || [])
    .filter((r) => r.tmdb_id && r.season != null && r.episode != null)
    .map((r) => ({ tmdbId: Number(r.tmdb_id), season: r.season, episode: r.episode }));
  const comments = (data.comments || [])
    .filter((c) => c.content && (c.movie_tmdb_id || (c.tmdb_id && c.season != null && c.episode != null)))
    .map((c) => ({
      oldId: c.id || null,
      parentOldId: c.parent_id || null,
      content: c.content,
      imageUrl: c.image_url || null,
      createdAt: c.created_at || null,
      movieTmdbId: c.movie_tmdb_id ? Number(c.movie_tmdb_id) : null,
      tmdbId: c.tmdb_id ? Number(c.tmdb_id) : null,
      season: c.season ?? null,
      episode: c.episode ?? null,
    }));
  const notes = (data.title_notes || [])
    .filter((n) => n.tmdb_id && n.note && (n.media_type === "show" || n.media_type === "movie"))
    .map((n) => ({ mediaType: n.media_type, tmdbId: Number(n.tmdb_id), note: String(n.note).slice(0, 2000), updatedAt: n.updated_at || null }));
  const characters = (data.favorite_characters || []).filter((c) => c.tmdb_person_id && c.source_type && c.source_tmdb_id);

  const shows = [...showsByTmdb.values()];
  return {
    shows,
    movies,
    extras: { rewatches, comments, characters, notes },
    stats: { totalShows: shows.length, totalMovies: movies.length },
  };
}

module.exports = { parseSceneraZip };
