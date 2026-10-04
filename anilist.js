// anilist.js
// Looks up a specific anime character's own artwork on AniList, for
// the "Fictional Character Vote" favorite-character feature. TMDB
// only ever gives us the voice actor's headshot (profile_path) —
// fine for live-action (the character IS the actor), not fine for
// anime, where fans expect the drawn character art instead. AniList
// is a free, no-key GraphQL API that models anime characters as
// their own entities with their own image, separate from voice
// actors — exactly the piece TMDB is missing.
//
// Best-effort only: a miss (title not found, character name doesn't
// match closely enough) just returns null, and the caller
// (favoriteCharacters.js) falls back to the TMDB actor photo like
// before. Never throws — a flaky/unreachable AniList should never
// block someone from favoriting a character.

const ANILIST_URL = "https://graphql.anilist.co";

const SEARCH_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME) {
    id
    title { romaji english }
    characters(perPage: 50, sort: [ROLE, RELEVANCE]) {
      nodes {
        name { full native alternative }
        image { large }
      }
    }
  }
}`;

function normalize(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// AniList character names are often "Given Family" while TMDB/our own
// characterName might be just one of those, or include a nickname in
// parentheses — so match loosely in both directions rather than
// requiring an exact string match.
function namesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function getAnimeCharacterImage(showTitle, characterName) {
  if (!showTitle || !characterName) return null;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: showTitle } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const media = json?.data?.Media;
    if (!media) return null;

    const candidates = characterName.split(/[,/]| as /i).map((s) => s.trim()).filter(Boolean);
    candidates.push(characterName);

    for (const node of media.characters?.nodes || []) {
      const allNames = [node.name?.full, node.name?.native, ...(node.name?.alternative || [])].filter(Boolean);
      for (const candidate of candidates) {
        if (allNames.some((n) => namesMatch(n, candidate))) {
          return node.image?.large || null;
        }
      }
    }
    return null;
  } catch (err) {
    console.error("AniList character lookup failed:", err.message);
    return null;
  }
}

module.exports = { getAnimeCharacterImage };
