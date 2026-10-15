// animePilot.js
// READ-ONLY experiment, not used by the app. For one anime it puts TMDB's
// season/episode layout next to AniList's, so we can see whether AniList's
// ("JP native") numbering would fix the cases where TMDB's is awkward — e.g.
// a long show that TMDB splits into many "seasons" while AniList has one
// entry with absolute numbering, or the opposite: a show AniList splits into
// several entries (cours / parts) while TMDB keeps it as one season.
//
// Nothing is written anywhere. Triggered by hand through
// POST /admin/anime-pilot (see server.js), same shared-secret pattern as the
// other /admin routes.

const TMDB_BASE = "https://api.themoviedb.org/3";
const ANILIST_URL = "https://graphql.anilist.co";
const MAX_CHAIN = 15; // AniList allows ~90 requests/minute; a franchise chain never needs more

async function tmdbShow(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/tv/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`);
  if (!res.ok) throw new Error(`TMDB request failed (${res.status})`);
  return res.json();
}

async function anilist(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList request failed (${res.status})`);
  const json = await res.json();
  if (json.errors) throw new Error(`AniList: ${json.errors[0]?.message || "error"}`);
  return json.data;
}

const MEDIA_FIELDS = `
  id idMal format status episodes seasonYear
  title { romaji english }
  relations { edges { relationType node { id type format } } }
`;

const SEARCH = `query ($s: String) { Page(perPage: 5) { media(search: $s, type: ANIME, format_in: [TV, TV_SHORT]) { ${MEDIA_FIELDS} } } }`;
const BY_ID = `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`;

const row = (m) => ({
  anilistId: m.id,
  malId: m.idMal ?? null,
  title: m.title?.english || m.title?.romaji,
  romaji: m.title?.romaji,
  format: m.format,
  year: m.seasonYear ?? null,
  episodes: m.episodes ?? null, // null = still airing / unknown
  status: m.status,
});

// Walks PREQUEL/SEQUEL links to collect every TV entry of the franchise, in
// the order AniList treats them as separate "seasons".
async function franchiseChain(start) {
  const seen = new Map([[start.id, start]]);
  const queue = [start];
  while (queue.length && seen.size < MAX_CHAIN) {
    const cur = queue.shift();
    for (const e of cur.relations?.edges || []) {
      if (!["PREQUEL", "SEQUEL"].includes(e.relationType)) continue;
      if (e.node?.type !== "ANIME" || !["TV", "TV_SHORT"].includes(e.node.format)) continue;
      if (seen.has(e.node.id) || seen.size >= MAX_CHAIN) continue;
      const data = await anilist(BY_ID, { id: e.node.id });
      seen.set(e.node.id, data.Media);
      queue.push(data.Media);
    }
  }
  return [...seen.values()].sort((a, b) => (a.seasonYear || 0) - (b.seasonYear || 0) || a.id - b.id);
}

// tmdbId: TMDB tv id. search: optional AniList search text if the TMDB title
// doesn't find the right entry (e.g. the TMDB title is a localized one).
async function runAnimePilot({ tmdbId, search }) {
  if (!tmdbId) throw new Error("tmdbId is required");
  const tv = await tmdbShow(tmdbId);
  const seasons = (tv.seasons || []).map((s) => ({ season: s.season_number, name: s.name, episodes: s.episode_count }));
  const tmdbRegular = seasons.filter((s) => s.season > 0);

  const text = search || tv.original_name || tv.name;
  const found = await anilist(SEARCH, { s: text });
  const candidates = found.Page?.media || [];
  if (candidates.length === 0) return { tmdb: { id: tmdbId, name: tv.name, seasons: tmdbRegular }, anilist: null, note: `AniList found nothing for "${text}"` };

  const chain = await franchiseChain(candidates[0]);
  const anilistEntries = chain.map(row);
  const tmdbTotal = tmdbRegular.reduce((n, s) => n + (s.episodes || 0), 0);
  const anilistKnown = anilistEntries.filter((e) => e.episodes != null);
  const anilistTotal = anilistKnown.reduce((n, e) => n + e.episodes, 0);

  return {
    searchedFor: text,
    pickedFirstResult: row(candidates[0]).title,
    otherCandidates: candidates.slice(1).map((m) => row(m).title),
    tmdb: { id: tmdbId, name: tv.name, originalName: tv.original_name, seasonCount: tmdbRegular.length, totalEpisodes: tmdbTotal, seasons: tmdbRegular },
    anilist: { entryCount: anilistEntries.length, totalEpisodes: anilistTotal, hasUnknownLength: anilistKnown.length !== anilistEntries.length, entries: anilistEntries },
    layout: tmdbRegular.length === anilistEntries.length ? "same number of seasons/entries" : `TMDB has ${tmdbRegular.length} season(s), AniList has ${anilistEntries.length} entr${anilistEntries.length === 1 ? "y" : "ies"}`,
    totalsAgree: tmdbTotal === anilistTotal,
  };
}

module.exports = { runAnimePilot };
