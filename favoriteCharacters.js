// favoriteCharacters.js
// Lets a user "heart" a specific actor/character they encounter on a
// show or movie's cast list, and see them collected on their profile.

async function getFavoriteCharacters(supabase, userId) {
  const { data, error } = await supabase
    .from("favorite_characters")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function addFavoriteCharacter(supabase, userId, character) {
  const { error } = await supabase
    .from("favorite_characters")
    .upsert({
      user_id: userId,
      tmdb_person_id: character.tmdbPersonId,
      person_name: character.personName,
      profile_path: character.profilePath || null,
      source_type: character.sourceType,
      source_tmdb_id: character.sourceTmdbId,
      source_title: character.sourceTitle,
      character_name: character.characterName || null,
    }, { onConflict: "user_id,tmdb_person_id,source_type,source_tmdb_id" });
  if (error) throw error;
  return { ok: true };
}

async function removeFavoriteCharacter(supabase, userId, tmdbPersonId, sourceType, sourceTmdbId) {
  const { error } = await supabase
    .from("favorite_characters")
    .delete()
    .eq("user_id", userId)
    .eq("tmdb_person_id", tmdbPersonId)
    .eq("source_type", sourceType)
    .eq("source_tmdb_id", sourceTmdbId);
  if (error) throw error;
  return { ok: true };
}

// Public tally for the "Fictional Character Vote" feature — every
// "favorite this actor" heart tap on a cast member (see
// addFavoriteCharacter above) already IS a vote; this just counts
// them per character for one show/movie. No separate votes table:
// the existing favorite_characters rows are the votes. Aggregated in
// JS rather than a Postgres GROUP BY since a single show's cast is
// at most a few hundred rows — cheap either way, and this avoids a
// bespoke RPC function just for a count.
async function getCharacterVoteCounts(supabase, sourceType, sourceTmdbId) {
  const { data, error } = await supabase
    .from("favorite_characters")
    .select("tmdb_person_id")
    .eq("source_type", sourceType)
    .eq("source_tmdb_id", sourceTmdbId);
  if (error) throw error;
  const counts = {};
  for (const row of data || []) {
    counts[row.tmdb_person_id] = (counts[row.tmdb_person_id] || 0) + 1;
  }
  return counts;
}

module.exports = { getFavoriteCharacters, addFavoriteCharacter, removeFavoriteCharacter, getCharacterVoteCounts };
