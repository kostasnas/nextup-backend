// favoriteCharacters.js
// Lets a user "heart" a specific actor/character they encounter on a
// show or movie's cast list, and see them collected on their profile.

const { getAnimeCharacterImage } = require("./anilist");

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
  // Anime-only: swap in the character's own drawn artwork from
  // AniList instead of the TMDB voice actor headshot (see anilist.js
  // for why). `isAnime` is a best-effort flag the client already
  // knows how to compute (TMDB genre 16 "Animation" + origin country
  // "JP" — same check ExploreScreen's SPECIAL_DISCOVER_PARAMS uses),
  // sent only so this never fires an extra network call for the
  // other 95%+ of live-action favorites. A miss here just leaves
  // character_image_url null and the UI falls back to profile_path.
  // sourceTitle is the episode label ("3. The Reunion") for
  // sourceType "episode" — no good for an AniList title search, so
  // the caller sends the actual show name separately as showTitle
  // when favoriting from inside an episode's cast modal.
  let characterImageUrl = null;
  if (character.isAnime && character.characterName) {
    characterImageUrl = await getAnimeCharacterImage(character.showTitle || character.sourceTitle, character.characterName);
  }

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
      character_image_url: characterImageUrl,
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
