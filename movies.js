// movies.js
// Movie watchlist — much simpler than the shows/episodes system:
// just planned (watchlist) or watched, no per-episode tracking.

async function getMovieWatchlist(supabase, userId) {
  const { data, error } = await supabase
    .from("user_movie_watchlist")
    .select("*, movies(*)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Ensures a movies row exists for this TMDB movie, returns its
 * internal id — same "upsert the shared row, then reference it"
 * pattern the shows table already uses.
 */
async function upsertMovie(supabase, tmdbMovie) {
  const { data: existing } = await supabase
    .from("movies")
    .select("id")
    .eq("tmdb_id", tmdbMovie.tmdb_id)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: inserted, error } = await supabase
    .from("movies")
    .insert({
      tmdb_id: tmdbMovie.tmdb_id,
      title: tmdbMovie.title,
      poster_path: tmdbMovie.poster_path,
      release_date: tmdbMovie.release_date || null,
      runtime: tmdbMovie.runtime || null,
      overview: tmdbMovie.overview || null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return inserted.id;
}

async function setMovieStatus(supabase, userId, tmdbMovie, status) {
  const movieId = await upsertMovie(supabase, tmdbMovie);
  const payload = {
    user_id: userId,
    movie_id: movieId,
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "watched") payload.watched_at = new Date().toISOString();

  const { error } = await supabase
    .from("user_movie_watchlist")
    .upsert(payload, { onConflict: "user_id,movie_id" });
  if (error) throw error;
  return { ok: true };
}

async function updateMovieEntry(supabase, userId, movieId, updates) {
  const { error } = await supabase
    .from("user_movie_watchlist")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("movie_id", movieId);
  if (error) throw error;
  return { ok: true };
}

async function removeMovie(supabase, userId, movieId) {
  const { error } = await supabase
    .from("user_movie_watchlist")
    .delete()
    .eq("user_id", userId)
    .eq("movie_id", movieId);
  if (error) throw error;
  return { ok: true };
}

module.exports = { getMovieWatchlist, setMovieStatus, updateMovieEntry, removeMovie };
