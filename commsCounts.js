// commsCounts.js
// Short-lived caches for the comment counts shown on movie and episode rows (CommsUni terms §A8.2:
// short TTL, refreshed after our own writes). Shared by commsBoard.js (reads) and commsWrite.js (invalidation).
const MOVIE_TTL_MS = 5 * 60 * 1000;
const EPISODE_TTL_MS = 10 * 60 * 1000;

const movieTotals = new Map();
const episodeTotals = new Map();

function getMovie(tmdbId) {
  const hit = movieTotals.get(tmdbId);
  return hit && Date.now() - hit.at < MOVIE_TTL_MS ? hit.count : undefined;
}
function setMovie(tmdbId, count) {
  if (movieTotals.size > 2000) movieTotals.clear();
  movieTotals.set(tmdbId, { at: Date.now(), count });
}
function getEpisode(key) {
  const hit = episodeTotals.get(key);
  return hit && Date.now() - hit.at < EPISODE_TTL_MS ? hit.count : undefined;
}
function setEpisode(key, count) {
  if (episodeTotals.size > 5000) episodeTotals.clear();
  episodeTotals.set(key, { at: Date.now(), count });
}

// After one of our users writes on a title, drop just that title's number.
function invalidateMovie(tmdbId) { movieTotals.delete(Number(tmdbId)); }
function invalidateEpisode(tvdbId, season, episode) { episodeTotals.delete(`${tvdbId}-${season}-${episode}`); }
// A reply or a delete does not say which title it belongs to, so forget everything (cheap: refilled on demand).
function invalidateAll() { movieTotals.clear(); episodeTotals.clear(); }

module.exports = { getMovie, setMovie, getEpisode, setEpisode, invalidateMovie, invalidateEpisode, invalidateAll };
