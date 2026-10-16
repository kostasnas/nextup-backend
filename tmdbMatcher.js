// tmdbMatcher.js
// Resolves TV Time show titles (from importParser.js output) to TMDB
// show IDs via fuzzy title search. TV Time's export has no TMDB/TVDB
// IDs at all — only its own internal tv_show_id — so title matching
// is the only option.
//
// Requires TMDB_API_KEY in the environment (Render → Environment tab).
// Never hardcode the key here.

const TMDB_BASE = "https://api.themoviedb.org/3";
const { throttle } = require("./tmdbThrottle");

/**
 * TV Time appends disambiguators to titles that collide with another
 * show, e.g. "Hostages (IL)", "Touch (2012)", "House of Cards (US)".
 * Sending that suffix straight into TMDB's search query returns zero
 * results — TMDB doesn't parse it as a hint, it just pollutes the
 * text match. Strip it before searching; keep the original title
 * around separately for scoring/display.
 */
function stripDisambiguator(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Generates alternative search queries for titles that don't match
 * TMDB's primary title at all — only tried as a fallback once the
 * normal search comes up empty/unconfident, so it costs nothing for
 * the ~97% of shows that already match fine. Handles patterns like:
 *   "Hinterland – Y Gwyll"        -> "Hinterland", "Y Gwyll"
 *   "Crime Diaries: The Search"   -> "Crime Diaries", "The Search"
 *   "Jo Nesbo's Detective Hole"   -> "Detective Hole"
 */
function alternativeTitleVariants(title) {
  const variants = new Set();

  const dashParts = title.split(/\s+[–—-]\s+/);
  if (dashParts.length > 1) dashParts.forEach((p) => variants.add(p.trim()));

  const colonParts = title.split(":");
  if (colonParts.length > 1) colonParts.forEach((p) => variants.add(p.trim()));

  const possessiveMatch = title.match(/^.+?'s\s+(.+)$/i);
  if (possessiveMatch) variants.add(possessiveMatch[1].trim());

  variants.delete(title);
  variants.delete("");
  return Array.from(variants);
}

/**
 * Search-friendly version of a title: punctuation that TV Time keeps
 * ("Jessi's Show!Terview", "P.S.NOTE") can make TMDB's search return
 * nothing, so turn it into spaces. Apostrophes stay (TMDB indexes
 * "Jessi's"). Only used as an extra fallback when the normal queries
 * came back empty, so titles that already match are untouched.
 */
function cleanQuery(title) {
  return stripDisambiguator(title)
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ARTICLE = /^(the|a|an|el|la|los|las|lo|o|os|as|um|uma|le|les|l'|der|die|das|il)\s+/i;

/**
 * "Loose" variants for titles that still found nothing confident.
 * TV Time often shows an English-style title for a show TMDB lists
 * under its original-language name ("The Serrano" -> "Los Serrano",
 * "The Secret of Puente Viejo" -> "El secreto de Puente Viejo"), so
 * dropping a leading article or the punctuation can surface it.
 * These are guesses: matchShow caps their score below the confidence
 * threshold, so they only ever fill the review list with candidates
 * and never auto-attach a show.
 */
function looseTitleVariants(title) {
  const base = stripDisambiguator(title);
  const variants = new Set();

  const noArticle = base.replace(LEADING_ARTICLE, "").trim();
  if (noArticle && noArticle !== base) variants.add(noArticle);

  const punct = cleanQuery(title);
  if (punct && punct !== base) variants.add(punct);

  const punctNoArticle = punct.replace(LEADING_ARTICLE, "").trim();
  if (punctNoArticle && punctNoArticle !== punct) variants.add(punctNoArticle);

  variants.delete(title);
  return Array.from(variants).filter((v) => v.length >= 3).slice(0, 3);
}

/**
 * Searches TMDB for a show title and returns ranked candidates.
 * Goes through the shared global throttle (tmdbThrottle.js) so that
 * many concurrent imports from different users never collectively
 * exceed TMDB's rate limit.
 * @param {string} title
 * @returns {Promise<Array<{id:number, name:string, first_air_date:string, popularity:number}>>}
 */
async function searchShow(title) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not set in environment");

  const cleanedTitle = stripDisambiguator(title);
  const url = `${TMDB_BASE}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(cleanedTitle)}&include_adult=false`;
  const data = await throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
    return res.json();
  });

  // Fallback: a few titles (e.g. non-Latin-script originals) may only
  // match with the suffix intact — retry once with the raw title if
  // the cleaned version found nothing.
  if ((data.results || []).length === 0 && cleanedTitle !== title) {
    const fallbackUrl = `${TMDB_BASE}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
    const fallbackData = await throttle(async () => {
      const res = await fetch(fallbackUrl);
      if (!res.ok) return { results: [] };
      return res.json();
    });
    if ((fallbackData.results || []).length > 0) return fallbackData.results;
  }

  // Last resort for titles with punctuation inside words ("Show!Terview",
  // "P.S.NOTE"): retry once with the punctuation turned into spaces.
  if ((data.results || []).length === 0) {
    const punctClean = cleanQuery(title);
    if (punctClean && punctClean !== cleanedTitle && punctClean !== title) {
      const punctUrl = `${TMDB_BASE}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(punctClean)}&include_adult=false`;
      const punctData = await throttle(async () => {
        const res = await fetch(punctUrl);
        if (!res.ok) return { results: [] };
        return res.json();
      });
      return punctData.results || [];
    }
  }

  return data.results || [];
}

async function searchMovie(title) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not set in environment");

  const cleanedTitle = stripDisambiguator(title);
  const url = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(cleanedTitle)}&include_adult=false`;
  const data = await throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
    return res.json();
  });

  if ((data.results || []).length === 0 && cleanedTitle !== title) {
    const fallbackUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
    const fallbackData = await throttle(async () => {
      const res = await fetch(fallbackUrl);
      if (!res.ok) return { results: [] };
      return res.json();
    });
    return fallbackData.results || [];
  }

  return data.results || [];
}

/**
 * Resolves a real external ID (IMDb's "tt..." const) straight to a
 * TMDB id — no fuzzy title matching needed, unlike matchShow/matchMovie
 * above, since the ID itself is authoritative. Used by imdbParser.js's
 * import pipeline (IMDb ratings exports carry a real imdb_id per row,
 * no TMDB id at all).
 *
 * TMDB's /find endpoint doesn't know in advance whether an id is a
 * movie or a show, so it returns both result arrays — the caller
 * picks whichever one is non-empty (an id is never both).
 * @returns {Promise<{movie: object|null, tv: object|null}>}
 */
async function findByImdbId(imdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not set in environment");

  const url = `${TMDB_BASE}/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
  const data = await throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB find failed: ${res.status}`);
    return res.json();
  });

  return {
    movie: (data.movie_results || [])[0] || null,
    // IMDb doesn't distinguish "TV Mini Series" from a regular series
    // in a way TMDB's /find mirrors — both land in tv_results, which
    // is all this needs.
    tv: (data.tv_results || [])[0] || null,
  };
}

/**
 * Fetches full season/episode structure for a matched show, needed
 * to translate "episodesSeenCount" into a season/episode marker.
 */
async function getShowDetails(tmdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  const url = `${TMDB_BASE}/tv/${tmdbId}?api_key=${apiKey}`;
  return throttle(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB show details failed: ${res.status}`);
    return res.json();
  });
}

/**
 * Basic string normalization for comparing titles: lowercase, strip
 * punctuation/parenthetical years, collapse whitespace. Handles
 * cases like "Bodyguard (2018)" from the real export sample.
 */
function normalizeTitle(str) {
  return str
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "") // strip any trailing parenthetical, not just years — "(US)", "(IL)", "(2018)" all need to go for fair comparison
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

function dedupeByBestScore(scoredCandidates) {
  const byId = new Map();
  for (const c of scoredCandidates) {
    if (!byId.has(c.id) || byId.get(c.id).score < c.score) byId.set(c.id, c);
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

const CONFIDENCE_THRESHOLD = 0.85;

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
  // Score against the original-language name too: TV Time sometimes
  // carries the show's original title while TMDB's English name differs.
  const titleScore = (text, c) =>
    Math.max(similarity(text, c.name), c.original_name ? similarity(text, c.original_name) : 0);
  let scored = dedupeByBestScore(
    candidates.map((c) => ({ ...c, score: titleScore(tvTimeTitle, c) }))
  );

  // Only spend extra requests chasing alternative titles when the
  // normal search didn't already find something confident — this
  // keeps the common case exactly as fast as before.
  if (!scored.length || scored[0].score < CONFIDENCE_THRESHOLD) {
    for (const variant of alternativeTitleVariants(tvTimeTitle)) {
      const variantCandidates = await searchShow(variant);
      scored = dedupeByBestScore([
        ...scored,
        // Score against the variant text actually used for this
        // search, not the full original title — a near-exact match
        // to "Hinterland" is what we want when the raw title is
        // "Hinterland – Y Gwyll"; scoring against the full messy
        // original would drag a correct match's score down for no reason.
        ...variantCandidates.map((c) => ({ ...c, score: titleScore(variant, c) })),
      ]);
      if (scored[0]?.score >= CONFIDENCE_THRESHOLD) break; // good enough, stop trying more variants
    }
  }

  // Still nothing confident: try the loose variants (leading article /
  // punctuation removed). Their scores are capped just below the
  // threshold, so a wrong guess can never be attached silently — they
  // only make sure the user gets candidates to pick from instead of none.
  if (!scored.length || scored[0].score < CONFIDENCE_THRESHOLD) {
    for (const variant of looseTitleVariants(tvTimeTitle)) {
      const variantCandidates = await searchShow(variant);
      scored = dedupeByBestScore([
        ...scored,
        ...variantCandidates.map((c) => ({
          ...c,
          score: Math.min(titleScore(variant, c), CONFIDENCE_THRESHOLD - 0.01),
        })),
      ]);
    }
  }

  if (scored.length === 0) {
    return { status: "no_match", candidates: [] };
  }

  const best = scored[0];
  if (best.score >= CONFIDENCE_THRESHOLD) {
    return { status: "matched", tmdbId: best.id, posterPath: best.poster_path || null, confidence: best.score, candidates: scored.slice(0, 5) };
  }

  // Not confident enough — surface top candidates for the user to pick,
  // written into import_unmatched (see schema.sql).
  return { status: "needs_review", candidates: scored.slice(0, 5) };
}

/**
 * Batch version. Requests all go through the shared global throttle
 * (tmdbThrottle.js), so it's safe to fire several shows' lookups
 * concurrently — pacing is enforced centrally across the whole server,
 * not just within this one import job. This also means many users
 * importing at the same time queue safely instead of each running
 * their own independent, uncoordinated delay loop.
 */
/**
 * Matches a movie title+year (e.g. from Letterboxd, which has no
 * TMDB ID at all) against TMDB search results. Year matters a lot
 * more here than for matchShow: movie titles collide constantly
 * across remakes/reboots/unrelated films sharing a name ("Spider-Man"
 * alone returns the 2002 Raimi film, 2017's Homecoming, and others),
 * where TV show titles rarely do. A year match is treated as a
 * strong signal and added on top of the title-similarity score,
 * rather than used as a hard filter — a slightly-off or missing year
 * shouldn't throw out an otherwise-obvious title match.
 */
async function matchMovie(title, year) {
  const candidates = await searchMovie(title);
  if (!candidates.length) return { status: "no_match", candidates: [] };

  const scored = candidates
    .map((c) => {
      const releaseYear = c.release_date ? parseInt(c.release_date.slice(0, 4), 10) : null;
      const titleScore = similarity(title, c.title);
      const score = year && releaseYear === year ? Math.min(titleScore + 0.3, 1) : titleScore;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score >= CONFIDENCE_THRESHOLD) {
    return { status: "matched", tmdbId: best.id, posterPath: best.poster_path || null, confidence: best.score, candidates: scored.slice(0, 5) };
  }
  return { status: "needs_review", candidates: scored.slice(0, 5) };
}

async function matchShows(tvTimeShows, { concurrency = 5 } = {}) {
  const results = [];
  for (let i = 0; i < tvTimeShows.length; i += concurrency) {
    const batch = tvTimeShows.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (show) => ({ ...show, match: await matchShow(show.title) }))
    );
    results.push(...batchResults);
  }
  return results;
}

module.exports = { searchShow, searchMovie, getShowDetails, matchShow, matchShows, matchMovie, findByImdbId, similarity, normalizeTitle, alternativeTitleVariants, looseTitleVariants, cleanQuery };
