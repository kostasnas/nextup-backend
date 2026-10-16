// sceneraParser.js
// Reads a zip produced by Scenera's own "Export my data" (see accountExport.js):
// scenera-export.json holds everything. Rows already carry the TMDB id, so
// nothing needs title matching. Returns shows (with episode + reaction logs)
// and movies in the shape processSceneraImport expects.
const AdmZip = require("adm-zip");

function parseSceneraZip(buffer) {
  const zip = new AdmZip(buffer);
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

  const shows = [...showsByTmdb.values()];
  return { shows, movies, stats: { totalShows: shows.length, totalMovies: movies.length } };
}

module.exports = { parseSceneraZip };
