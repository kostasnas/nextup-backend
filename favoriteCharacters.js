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

module.exports = { getFavoriteCharacters, addFavoriteCharacter, removeFavoriteCharacter };
