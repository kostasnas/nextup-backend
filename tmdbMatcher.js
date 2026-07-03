// tmdbMatcher.js
// Resolves TV Time show titles (from importParser.js output) to TMDB
// show IDs via fuzzy title search. TV Time's export has no TMDB/TVDB
// IDs at all — only its own internal tv_show_id — so title matching
// is the only option.
//
// Requires TMDB_API_KEY in the environment (Render → Environment tab).
// Never hardcode the key here.

const TMDB_BASE = "https://api.themoviedb.org/3";

/**
 * Searches TMDB for a show title and returns ranked candidates.
 * @param {string} title
 * @returns {Promise<Array<{id:number, name:string, first_air_date:string, popularity:number}>>}
 */
async function searchShow(title) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not set in environment");

  const url = `${TMDB_BASE}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

/**
 * Fetches full season/episode structure for a matched show, needed
 * to translate "episodesSeenCount" into a season/episode marker.
 */
async function getShowDetails(tmdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  const url = `${TMDB_BASE}/tv/${tmdbId}?api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB show details failed: ${res.status}`);
  return res.json();
}

/**
 * Basic string normalization for comparing titles: lowercase, strip
 * punctuation/parenthetical years, collapse whitespace. Handles
 * cases like "Bodyguard (2018)" from the real export sample.
 */
function normalizeTitle(str) {
  return str
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "") // strip trailing (2018) year markers
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Simple Levenshtein-based similarity score, 0 (no match) to 1 (exact).
 */
function similarity(a, b) {
  const s1 = normalizeTitle(a);
  const s2 = normalizeTitle(b);
  if (s1 === s2) return 1;

  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) costs[j] = j;
      else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1[i - 1] !== s2[j - 1]) {
          newValue = Math.min(newValue, lastValue, costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  const distance = costs[s2.length];
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/**
 * Matches one TV Time show against TMDB search results.
 * Returns a confident match, or a list of candidates for manual review.
 *
 * Confidence threshold of 0.85 is a starting point — tune against
 * real import runs. Prefer under-matching (send to manual review)
 * over silently attaching the wrong show to someone's history.
 */
async function matchShow(tvTimeTitle) {
  const candidates = await searchShow(tvTimeTitle);
  if (candidates.length === 0) {
    return { status: "no_match", candidates: [] };
  }

  const scored = candidates
    .map((c) => ({ ...c, score: similarity(tvTimeTitle, c.name) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const CONFIDENCE_THRESHOLD = 0.85;

  if (best.score >= CONFIDENCE_THRESHOLD) {
    return { status: "matched", tmdbId: best.id, confidence: best.score, candidates: scored.slice(0, 5) };
  }

  // Not confident enough — surface top candidates for the user to pick,
  // written into import_unmatched (see schema.sql).
  return { status: "needs_review", candidates: scored.slice(0, 5) };
}

/**
 * Batch version with basic rate-limit pacing (TMDB free tier: ~50 req/s,
 * but we stay conservative since this runs unattended during import).
 */
async function matchShows(tvTimeShows, { delayMs = 250 } = {}) {
  const results = [];
  for (const show of tvTimeShows) {
    const match = await matchShow(show.title);
    results.push({ ...show, match });
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}

module.exports = { searchShow, getShowDetails, matchShow, matchShows, similarity, normalizeTitle };
