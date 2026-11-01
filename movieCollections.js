// movieCollections.js
// Which franchise ("The Dark Knight Collection") each movie belongs to, stored on the shared movies row
// (migrations/movie_collections.sql) so the Movies tab can show "Your sagas" with progress without asking TMDB
// for every movie on every visit.
//
// The column is filled lazily and in the background: a person's own unchecked movies when they open the tab,
// a single movie when it is added, and an admin call for everything already stored. Imports never wait for it.

const { throttle } = require("./tmdbThrottle");
const { forEachConcurrent } = require("./concurrency");

const TMDB_BASE = "https://api.themoviedb.org/3";
const FILL_PER_VISIT = 150; // one person's unchecked movies handled per Movies tab visit
const MAX_SAGAS = 30;

async function fetchMovieCollection(tmdbId) {
  const movie = await throttle(async () => {
    const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`);
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error(`TMDB fetch failed (${res.status}): /movie/${tmdbId}`);
    return res.json();
  });
  const c = movie.belongs_to_collection;
  return c && c.id ? { id: c.id, name: c.name || null } : null;
}

// Asks TMDB about one stored movie and records the answer. A network or TMDB error leaves it unchecked for next time.
async function fillMovieCollection(supabase, movie) {
  try {
    const col = await fetchMovieCollection(movie.tmdb_id);
    await supabase.from("movies").update({
      collection_id: col ? col.id : null,
      collection_name: col ? col.name : null,
      collection_checked_at: new Date().toISOString(),
    }).eq("id", movie.id);
    return true;
  } catch (err) {
    console.error(`Movie collection lookup failed for tmdb_id=${movie.tmdb_id}:`, err.message);
    return false;
  }
}

const filling = new Set(); // user ids whose batch is already running

// Fire and forget: fills one batch of this person's unchecked movies. Returns how many were left before it started.
async function startFillForUser(supabase, userId) {
  const { data, count } = await supabase
    .from("user_movie_watchlist")
    .select("movies!inner(id, tmdb_id, collection_checked_at)", { count: "exact" })
    .eq("user_id", userId)
    .is("movies.collection_checked_at", null)
    .limit(FILL_PER_VISIT);
  const pending = count ?? (data || []).length;
  if (!data || data.length === 0 || filling.has(userId)) return pending;
  filling.add(userId);
  forEachConcurrent(data.map((r) => r.movies), 6, (m) => fillMovieCollection(supabase, m))
    .catch((e) => console.error("Movie collection fill failed:", e.message))
    .finally(() => filling.delete(userId));
  return pending;
}

// The person's sagas: every franchise they have at least one movie from, with how many of those they watched.
// The total number of films in a franchise comes from TMDB in the app (it already loads the saga page from there).
async function getSagas(supabase, userId) {
  const pending = await startFillForUser(supabase, userId);
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("user_movie_watchlist")
      .select("status, updated_at, movies!inner(tmdb_id, title, poster_path, collection_id, collection_name)")
      .eq("user_id", userId)
      .not("movies.collection_id", "is", null)
      .order("updated_at", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byId = new Map();
  for (const r of rows) {
    const m = r.movies;
    let s = byId.get(m.collection_id);
    if (!s) { s = { id: m.collection_id, name: m.collection_name, seen: 0, listed: 0, posters: [], latest: r.updated_at }; byId.set(m.collection_id, s); }
    s.listed++;
    if (r.status === "watched") s.seen++;
    if (m.poster_path && s.posters.length < 3) s.posters.push(m.poster_path); // the three most recently touched films
  }
  const sagas = [...byId.values()].sort((a, b) => (b.seen > 0) - (a.seen > 0) || String(b.latest).localeCompare(String(a.latest))).slice(0, MAX_SAGAS);
  return { sagas, pending };
}

module.exports = { fillMovieCollection, getSagas };
