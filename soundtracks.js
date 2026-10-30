// soundtracks.js
// Soundtrack of a show or movie: find its album, list the songs, and let a person save individual songs to find
// them again under Profile > Soundtracks. Full songs are listened to in the person's own music app (the app opens
// YouTube or Spotify, like a trailer); from here only the 30 second preview links Deezer publishes are passed on.
//
// The music comes from Deezer's public API (no key needed): TMDB has no soundtrack data. Finding the right album is a
// best-effort search on the title, so the app shows what it found and the person can switch between a few candidates.
// Saved songs live in user_saved_tracks (see migrations/user_saved_tracks.sql), through the direct Postgres pool.
const { getPool } = require("./db");

const DEEZER = "https://api.deezer.com";
const MAX_SAVED = 2000;
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const TRACKS_TTL_MS = 30 * 60 * 1000; // preview links carry an expiry, so song lists are not kept for long
const CACHE_MAX = 500;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const cleanText = (s, max) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const cleanPoster = (p) => (typeof p === "string" && /^\/[A-Za-z0-9._-]{3,80}$/.test(p) ? p : null);
const cleanCover = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname.endsWith(".dzcdn.net") || url.hostname.endsWith(".mzstatic.com")) ? url.toString().slice(0, 300) : null;
  } catch {
    return null;
  }
};
const kindOf = (k) => (k === "movie" ? "movie" : k === "show" ? "show" : null);

// ---- a small in-memory cache (cleared when the server restarts, which is fine) ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { cache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttl });
}

// The same cache, shared by everybody and kept in the database (migrations/soundtrack_cache.sql): the first person who opens a
// title makes the lookup, later people and restarts read it. Every step is optional: no table or connection = memory only.
async function dbCacheGet(key, maxDays) {
  try {
    const { rows } = await getPool().query(
      "select value from soundtrack_cache where key = $1 and updated_at > now() - ($2 || ' days')::interval", [key, String(maxDays)]);
    return rows[0] ? rows[0].value : null;
  } catch { return null; }
}
async function dbCacheSet(key, value) {
  try {
    await getPool().query(
      `insert into soundtrack_cache (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, JSON.stringify(value)]);
  } catch { /* table not created yet, or no connection: the memory cache still works */ }
}
const DB_DAYS = 180;

async function deezer(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`${DEEZER}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw httpError(502, "Music service unavailable");
    const data = await res.json();
    // Deezer answers 200 with an { error } body for things like "no data" or "quota".
    if (data && data.error) throw httpError(data.error.code === 4 ? 429 : 502, "Music service unavailable");
    return data;
  } catch (e) {
    if (e.status) throw e;
    throw httpError(502, "Music service unavailable");
  } finally {
    clearTimeout(timer);
  }
}

// iTunes Search API (no key): the second source, used when Deezer has no matching album or cannot be reached. Its ids
// are stored as id + ITUNES_OFFSET so they fit the same numeric columns and routes as Deezer's, and never collide with them.
const ITUNES = "https://itunes.apple.com";
const ITUNES_OFFSET = 1e12;
const isItunesId = (id) => Number(id) >= ITUNES_OFFSET;
async function itunes(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`${ITUNES}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw httpError(502, "Music service unavailable");
    return await res.json();
  } catch (e) {
    if (e.status) throw e;
    throw httpError(502, "Music service unavailable");
  } finally {
    clearTimeout(timer);
  }
}
// An iTunes album in the shape the Deezer ranking code reads.
function itunesAlbum(r) {
  if (!r || r.wrapperType !== "collection" || !r.collectionId) return null;
  const single = /-\s*(single|ep)$/i.test(String(r.collectionName || "").trim());
  return {
    id: r.collectionId + ITUNES_OFFSET,
    title: r.collectionName || "",
    artist: { name: r.artistName || "" },
    release_date: String(r.releaseDate || "").slice(0, 10),
    nb_tracks: r.trackCount || 0,
    record_type: single ? "single" : "album",
    cover_medium: typeof r.artworkUrl100 === "string" ? r.artworkUrl100.replace(/\/\d+x\d+bb\./, "/300x300bb.") : null,
  };
}

// ---- finding the album ----
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const SOUNDTRACK_WORDS = /\b(soundtrack|score|ost|original|music from|motion picture|series|television|tv)\b/;
const NOT_WANTED = /\b(karaoke|tribute|lullaby|lullabies|piano version|piano tribute|8 bit|made famous|in the style of|workout|cover version|covers|instrumental version|inspired|trailer|teaser|tv spot|minimad|remix|remixes|sped up|slowed|nightcore|lo fi|lofi|music box|relaxing|sleep|parody|reaction|ringtones?)\b/;

// Official releases say so: "(Original Series Soundtrack)", "(Original Motion Picture Score)", "Music from ...".
// Covers, "inspired by" albums and trailer uploads don't, so this works for any title without a list of bad words.
const OFFICIAL = /\boriginal\b.*\b(soundtrack|score|series|motion picture|television|tv|music|film|movie)\b|\bmusic (from|inspired by the)\b|\bofficial (soundtrack|score)\b/;
const isOfficial = (album) => OFFICIAL.test(norm(album.title));

// After the title, an official album's name only holds words like these ("Season 2", "Original Series Soundtrack",
// "Deluxe Edition"). Any other word means a different work: "Carrie Pilby", "Carrie TV Emotional Musical ...".
const NAME_FILLER = new Set(("original motion picture soundtrack score music from the film movie series tv television season vol volume " +
  "deluxe edition expanded complete official apple netflix hbo max disney amazon prime video plus a an and of ost digital " +
  "remastered anniversary special version limited bonus tracks cast recording").split(" "));
const isTitleAlbum = (album, wanted) => {
  const name = norm(album.title);
  return wanted.some((t) => {
    if (!(name === t || name.startsWith(`${t} `))) return false;
    // A number or roman numeral is fine after "season" or "vol" ("Season 2"), but straight after the title it is another
    // installment: "Street Fighter II", "Toy Story 2", "Rocky III" are not "Street Fighter", "Toy Story", "Rocky".
    const NUMBER = /^(\d+|[ivxlc]+)$/;
    const words = name.slice(t.length).split(" ").filter(Boolean);
    return words.every((w, i) => NAME_FILLER.has(w) || (NUMBER.test(w) && ["season", "vol", "volume"].includes(words[i - 1])));
  });
};

function rankAlbum(album, titles) {
  const name = norm(album.title);
  if (NOT_WANTED.test(name) || NOT_WANTED.test(norm(album.artist?.name))) return -1;
  // Singles and two-song releases are uploads of one track (a trailer, a title theme), not the soundtrack.
  if (album.record_type === "single" || (album.nb_tracks && album.nb_tracks < 3)) return -1;
  let score = 0;
  if (titles.some((t) => t && name.includes(t))) score += 5;
  else return -1; // an album that doesn't mention the title is never the soundtrack
  if (SOUNDTRACK_WORDS.test(name)) score += 3;
  if (titles.some((t) => t && (name === t || name.startsWith(`${t} `)))) score += 1;
  return score;
}

// Catalogues often drop the leading article: the film is "The Last of the Mohicans", the album "Last of the Mohicans (Original
// Motion Picture Soundtrack)". So a title with 2+ words left after the article is also wanted without it.
const LEADING_ARTICLE = /^(the|a|an|der|die|das|le|la|les|el|los|las|il|lo|i|gli)\s+/;
const withoutArticle = (name) => {
  const rest = name.replace(LEADING_ARTICLE, "");
  return rest !== name && rest.split(" ").length >= 2 ? rest : null;
};

// Ranks and narrows candidate albums (Deezer-shaped objects, from either source) down to the few worth showing.
function pickAlbums(found, wanted, year, composerNames) {
  const byId = new Map();
  for (const a of found) if (a && a.id && !byId.has(a.id)) byId.set(a.id, a);
  const scored = [...byId.values()]
    .map((a) => ({ a, score: rankAlbum(a, wanted) + (year && String(a.release_date || "").startsWith(String(year)) ? 1 : 0) }))
    // A soundtrack cannot come out years before the film or show it is for ("Lupin" 2021 is not "Lupin the Third"). One year of
    // slack for early releases. Deezer's search results often carry no release date at all, and then this does nothing.
    .filter((x) => {
      if (!year) return true;
      const y = parseInt(String(x.a.release_date || "").slice(0, 4), 10);
      return !Number.isInteger(y) || y >= Number(year) - 1;
    })
    .sort((x, y) => y.score - x.score || (y.a.nb_tracks || 0) - (x.a.nb_tracks || 0));
  const candidates = scored.filter((x) => x.score >= 8); // title in the name AND it looks like a soundtrack/score
  const byComposer = (x) => composerNames.some((c) => norm(x.a.artist?.name).includes(c));
  const isVarious = (x) => /\b(various|verschiedene|varios|varie|divers|artistes?)\b/.test(norm(x.a.artist?.name));

  let pool;
  // The album by the person TMDB lists as the composer is the strongest sign there is. It wins over everything else, including
  // albums that look more like a plain "<title> (Soundtrack)": for "Lupin" that is how the Netflix series' albums by Mathieu
  // Lamboley beat a "Lupin (Original TV Series Soundtrack)" compilation and 25 "Lupin the Third" albums. Their names are often
  // loose ("Lupin: Part 4 (Bande originale ...)"), so any album with the title in its name counts. Compilations of songs by
  // various artists still follow them.
  const composed = composerNames.length ? scored.filter((x) => x.score >= 5 && byComposer(x)) : [];
  if (composed.length) {
    composed.sort((x, y) => x.a.title.localeCompare(y.a.title, undefined, { numeric: true }));
    pool = [...composed, ...candidates.filter((x) => isVarious(x) && !composed.includes(x))];
  } else {
    // 1. Albums that call themselves the original soundtrack. 2. Of those, the ones named after this title and nothing else
    // ("Severance: Season 1 (...)" yes, "Life On Earth: Severance (...)" and "Carrie Pilby (...)" no). 3. The ones released around the
    // film's or show's year. Each step only narrows the list when something is left, so an unusual title never ends up empty.
    const official = candidates.filter((x) => isOfficial(x.a));
    pool = official.length ? official : candidates;
    const narrow = (fn) => { const f = pool.filter(fn); if (f.length) pool = f; };
    narrow((x) => isTitleAlbum(x.a, wanted));
    if (year) {
      narrow((x) => {
        const y = parseInt(String(x.a.release_date || "").slice(0, 4), 10);
        return Number.isInteger(y) && y >= year - 1 && y <= year + 2;
      });
    }
  }
  // Only when there are no official albums (older or obscure titles) do the looser matches show up, and then just the best few.
  const limit = composed.length || candidates.some((x) => isOfficial(x.a)) ? 5 : 3;
  return pool.slice(0, limit).map(({ a }) => ({
    id: String(a.id),
    title: a.title,
    artist: a.artist?.name || "",
    cover: cleanCover(a.cover_medium) || cleanCover(a.cover) || null,
    trackCount: a.nb_tracks || null,
  }));
}

// A small record of what was searched and what came out (migrations/soundtrack_search_log.sql, also created on first use), so
// the titles that find nothing can be looked at later instead of guessed. Never blocks or breaks a search.
let logReady = null;
function logSearch(titles, year, composers, source, found) {
  (async () => {
    try {
      const pool = getPool();
      if (!logReady) {
        logReady = pool.query(`
          create table if not exists soundtrack_search_log (
            id bigserial primary key,
            title text not null,
            year integer,
            composers text,
            source text not null,
            found integer not null,
            created_at timestamptz not null default now()
          );
          alter table soundtrack_search_log enable row level security;`).catch((e) => { logReady = null; throw e; });
      }
      await logReady;
      await pool.query("insert into soundtrack_search_log (title, year, composers, source, found) values ($1,$2,$3,$4,$5)",
        [titles.filter(Boolean).join(" / ").slice(0, 200), year || null, composers.join(", ").slice(0, 200) || null, source, found]);
    } catch { /* logging is optional */ }
  })();
}

// ---- choosing the right albums ----
// Rules on album names kept breaking on the next title ("Pt. 1", "Part 4", "Bande originale", "Vol. 2"...). So the choice is made
// by a model that knows the productions, from a list of albums the music services really returned. It can only pick from that
// list (it answers with numbers, anything else is thrown away), and when it is not sure it picks nothing. The rules in
// pickAlbums stay as the fallback for when the model is not reachable.
const AI_MODEL = process.env.GROQ_ALBUMS_MODEL || process.env.GROQ_SONGS_MODEL || "openai/gpt-oss-120b";
const MAX_CANDIDATES = 60;

// Albums that could be about this title: its name is in the album's name, or the album is by the composer. Best ones first.
function albumCandidates(found, wanted, composerNames) {
  const byId = new Map();
  for (const a of found) if (a && a.id && !byId.has(a.id)) byId.set(a.id, a);
  const byComposer = (a) => composerNames.some((c) => norm(a.artist?.name).includes(c));
  return [...byId.values()]
    .map((a) => ({ a, score: rankAlbum(a, wanted), comp: byComposer(a) }))
    .filter((x) => x.score >= 5 || (x.comp && x.score >= 1))
    .sort((x, y) => Number(y.comp) - Number(x.comp) || y.score - x.score || (y.a.nb_tracks || 0) - (x.a.nb_tracks || 0))
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.a);
}

// Deezer's search results carry no release date. One lookup per candidate fills it in (and the real track count).
async function withReleaseDates(list) {
  // A few at a time: Deezer refuses bursts (about 50 requests per 5 seconds).
  for (let i = 0; i < list.length; i += 12) {
    await Promise.allSettled(list.slice(i, i + 12).map(async (a) => {
      if (a.release_date || isItunesId(a.id)) return;
      const full = await deezer(`/album/${a.id}`);
      if (full && full.release_date) a.release_date = full.release_date;
      if (full && full.nb_tracks) a.nb_tracks = full.nb_tracks;
    }));
  }
  return list;
}

// Returns an array of the picked candidates (possibly empty = "none of these"), or null when the model could not be asked.
async function aiPickAlbums(list, titles, year, composers) {
  if (!process.env.GROQ_API_KEY || !list.length) return null;
  const lines = list.map((a, i) => `${i + 1} | ${a.title} | ${a.artist?.name || "?"} | ${String(a.release_date || "?").slice(0, 4)} | ${a.nb_tracks || "?"} tracks`).join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0,
        max_tokens: 3000, // this model writes a reasoning trace first
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You match music albums to a TV series or film. You get the production and a numbered list of albums found on music services. " +
              "Pick the albums that are the official soundtrack or score of THAT production: the release made for it (original score, original " +
              "series/motion picture soundtrack, music from it, any season, part or volume of it, in any language). Do NOT pick albums of a " +
              "different production that shares the name or part of it (another film, a remake, an anime, a different series), compilations " +
              "not made for it, covers, karaoke or tribute albums. Use the year and the composer as evidence. When you are not sure an album " +
              "belongs to this production, leave it out; an empty answer is better than a wrong one. Order the picks the way a listener would " +
              "start: the main or first release first, then later seasons, parts or volumes in order. At most 6. " +
              'Answer as JSON: {"picks":[numbers from the list]}, or {"picks":[]} if none fit.',
          },
          { role: "user", content: `Production: ${titles.join(" / ")}${year ? ` (${year})` : ""}\nComposer: ${composers.join(", ") || "unknown"}\n\nAlbums (number | name | artist | year | tracks):\n${lines}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "");
    if (!parsed || !Array.isArray(parsed.picks)) return null;
    const seen = new Set();
    const out = [];
    for (const n of parsed.picks) {
      const i = Number(n) - 1;
      if (Number.isInteger(i) && list[i] && !seen.has(i)) { seen.add(i); out.push(list[i]); }
    }
    // Oldest first, so a series reads Part 1, Part 2, Part 3... whatever order the model wrote them in. Albums with no date keep their place.
    const when = (a) => (/^\d{4}/.test(String(a.release_date || "")) ? String(a.release_date) : null);
    const dated = out.filter(when).sort((x, y) => when(x).localeCompare(when(y)));
    return (dated.length === out.length ? dated : out).slice(0, 6);
  } catch (e) {
    console.error("soundtrack album pick failed:", e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const toResult = (a) => ({
  id: String(a.id),
  title: a.title,
  artist: a.artist?.name || "",
  cover: cleanCover(a.cover_medium) || cleanCover(a.cover) || null,
  trackCount: a.nb_tracks || null,
});

// A person (through /admin/soundtrack-set) can pin the right albums for a title. That wins over everything and does not expire.
const overrideKey = (title, year) => `override:${norm(title || "")}:${year || ""}`;

// For /admin/soundtrack-debug: the same search as findAlbums, uncached, showing every album Deezer returned and what the ranking
// did with it. Used to see why a title gets the wrong album.
async function debugAlbums(titles, year, composers = []) {
  const wanted = [...new Set(titles.map(norm).filter(Boolean).flatMap((t) => [t, withoutArticle(t)].filter(Boolean)))];
  const composerNames = composers.map(norm).filter((c) => c.length > 2);
  const searchTitles = [...new Set(titles.filter(Boolean).flatMap((t) => [t, withoutArticle(norm(t))].filter(Boolean)))];
  const qs = [];
  for (const t of searchTitles) { qs.push(`album:"${t}"`); qs.push(`${t} soundtrack`); }
  for (const c of composers.slice(0, 2)) qs.push(`artist:"${c}" album:"${searchTitles[0]}"`);
  qs.push(`${searchTitles[0]} original series soundtrack`, `${searchTitles[0]} original motion picture soundtrack`, `${searchTitles[0]} music from the series`);
  const settled = await Promise.allSettled(qs.map((q, i) => deezer(`/search/album?q=${encodeURIComponent(q)}&limit=${i < searchTitles.length * 2 ? 100 : 50}`)));
  const byId = new Map();
  const errors = [];
  settled.forEach((r, i) => { if (r.status === "fulfilled") for (const a of r.value.data || []) { if (a && a.id && !byId.has(a.id)) byId.set(a.id, a); } else errors.push(`${qs[i]}: ${r.reason?.message}`); });
  const kept = new Set(pickAlbums([...byId.values()], wanted, year, composerNames).map((a) => a.id));
  const cands = await withReleaseDates(albumCandidates([...byId.values()], wanted, composerNames));
  const picked = await aiPickAlbums(cands, titles, year, composers);
  const aiIds = new Set((picked || []).map((a) => String(a.id)));
  return {
    wanted, year, composers: composerNames, queries: qs, errors,
    ai: picked === null ? "unavailable (no GROQ_API_KEY or the call failed): the plain rules are used" : (picked.length ? picked.map(toResult) : "picked nothing"),
    candidates: cands.map((a) => ({ id: a.id, title: a.title, artist: a.artist?.name, released: a.release_date, tracks: a.nb_tracks, picked: aiIds.has(String(a.id)) })),
    albums: [...byId.values()].map((a) => ({
      id: a.id, title: a.title, artist: a.artist?.name, released: a.release_date, tracks: a.nb_tracks, type: a.record_type,
      score: rankAlbum(a, wanted), official: isOfficial(a), titleAlbum: isTitleAlbum(a, wanted), kept: kept.has(String(a.id)),
    })).sort((x, y) => Number(y.kept) - Number(x.kept) || y.score - x.score),
  };
}

// Pins albums (Deezer ids) for a title; they are what findAlbums returns for it from then on. Empty list = remove the pin.
async function pinAlbums(titles, year, ids) {
  const keys = titles.map((t) => overrideKey(t, year));
  if (!ids.length) {
    try { await getPool().query("delete from soundtrack_cache where key = any($1)", [keys]); } catch { /* nothing pinned */ }
    cache.clear();
    return [];
  }
  const albums = [];
  for (const id of ids) {
    const a = await deezer(`/album/${id}`);
    if (a && a.id) albums.push(toResult(a));
  }
  if (!albums.length) throw httpError(404, "None of those albums exist");
  for (const key of keys) await dbCacheSet(key, albums);
  cache.clear();
  return albums;
}

async function findAlbums(titles, year, composers = []) {
  const wanted = [...new Set(titles.map(norm).filter(Boolean).flatMap((t) => [t, withoutArticle(t)].filter(Boolean)))];
  if (!wanted.length) return [];
  const composerNames = composers.map(norm).filter((c) => c.length > 2);
  // v5: wider search (100 results + a "music from the series" query). v4: picks are ordered oldest first. v3: albums are chosen by the model now (v2 and older held wrong albums, e.g. Lupin III for Lupin).
  for (const t of titles) {
    const pinned = await dbCacheGet(overrideKey(t, year), 36500);
    if (Array.isArray(pinned) && pinned.length) return pinned;
  }
  const key = `albums:v5:${wanted.join("|")}:${year || ""}:${composerNames.join("|")}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const stored = await dbCacheGet(key, DB_DAYS);
  if (Array.isArray(stored) && stored.length) { cacheSet(key, stored, SEARCH_TTL_MS); return stored; }

  const searchTitles = [...new Set(titles.filter(Boolean).flatMap((t) => [t, withoutArticle(norm(t))].filter(Boolean)))];
  const topComposers = composers.filter((c) => norm(c).length > 2).slice(0, 2);

  // Deezer. Angles per title: albums whose name contains it, and a plain "<title> soundtrack" search. With a composer, also
  // "artist + album", the most precise search there is (it finds albums whose title is written a little differently).
  const queries = [];
  for (const t of searchTitles) {
    // 100 results: a title shared with a big franchise (25+ "Lupin the Third" albums) would otherwise push the real one out of the list.
    queries.push(`/search/album?q=${encodeURIComponent(`album:"${t}"`)}&limit=100`);
    queries.push(`/search/album?q=${encodeURIComponent(`${t} soundtrack`)}&limit=100`);
  }
  for (const c of topComposers) queries.push(`/search/album?q=${encodeURIComponent(`artist:"${c}" album:"${searchTitles[0]}"`)}&limit=25`);
  // Official releases are named "(Original Series Soundtrack)" or "(Original Motion Picture Soundtrack)": asking for those words
  // brings them up above the other works that share the title's word ("Lupin" the show vs "Lupin the Third" the anime).
  queries.push(`/search/album?q=${encodeURIComponent(`${searchTitles[0]} original series soundtrack`)}&limit=25`);
  queries.push(`/search/album?q=${encodeURIComponent(`${searchTitles[0]} original motion picture soundtrack`)}&limit=25`);
  queries.push(`/search/album?q=${encodeURIComponent(`${searchTitles[0]} music from the series`)}&limit=50`);
  const settled = await Promise.allSettled(queries.map((q) => deezer(q)));
  const deezerDown = settled.every((s) => s.status === "rejected");
  const found = [];
  for (const s of settled) if (s.status === "fulfilled") found.push(...(s.value.data || []));
  let source = "none";
  let ranked = [];
  let aiFailed = false;
  if (!deezerDown) {
    const list = await withReleaseDates(albumCandidates(found, wanted, composerNames));
    const picked = await aiPickAlbums(list, titles, year, composers);
    if (picked) { ranked = picked.map(toResult); source = ranked.length ? "deezer+ai" : "none"; }
    else { aiFailed = true; ranked = pickAlbums(found, wanted, year, composerNames); if (ranked.length) source = "deezer"; }
  }

  // Second source: iTunes, when Deezer found nothing usable or could not be reached. Same ranking, same filters.
  let itunesFailed = false;
  if (!ranked.length) {
    const terms = searchTitles.flatMap((t) => [`${t} soundtrack`, `${t} original score`]);
    for (const c of topComposers) terms.push(`${c} ${searchTitles[0]}`);
    const results = await Promise.allSettled([...new Set(terms)].map((term) =>
      itunes(`/search?term=${encodeURIComponent(term)}&media=music&entity=album&limit=25`)));
    itunesFailed = results.every((r) => r.status === "rejected");
    const items = [];
    for (const r of results) if (r.status === "fulfilled") for (const x of r.value.results || []) { const a = itunesAlbum(x); if (a) items.push(a); }
    const picked = await aiPickAlbums(albumCandidates(items, wanted, composerNames), titles, year, composers);
    if (picked) { ranked = picked.map(toResult); if (ranked.length) source = "itunes+ai"; }
    else { aiFailed = true; ranked = pickAlbums(items, wanted, year, composerNames); if (ranked.length) source = "itunes"; }
  }

  if (deezerDown && itunesFailed) throw httpError(502, "Music service unavailable");
  // Found albums are kept for everybody. "Nothing found" is only remembered briefly, and not at all when part of the search failed.
  const partial = deezerDown || itunesFailed || settled.some((x) => x.status === "rejected");
  if (ranked.length && aiFailed) cacheSet(key, ranked, 60 * 60 * 1000); // chosen by the plain rules: kept an hour, then asked again
  else if (ranked.length) { cacheSet(key, ranked, SEARCH_TTL_MS); await dbCacheSet(key, ranked); }
  else if (!partial) cacheSet(key, ranked, 60 * 60 * 1000);
  if (!partial || ranked.length) logSearch(titles, year, composers, source, ranked.length);
  return ranked;
}

// ---- songs that are in the show or film (not the composer's score) ----
// No free database says which songs play in which title, and asking a model to recall them invents some. So the song names
// come from the title's own Wikipedia article: IMDb id -> Wikidata -> the English article -> its music section. A model
// only reads that text and lists the songs in it, and any song whose name is not written in the text is thrown away.
// Each one is then looked up on Deezer for the preview. A title with no usable article simply has no list.
const FEATURED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTICLE_CHARS = 7000;

async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Scenera/1.0 (https://scenera.online)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// IMDb id -> title of the English Wikipedia article, through Wikidata (exact, no guessing from the name).
async function wikipediaTitleFor(imdbId) {
  const search = await getJson(
    `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P345=${imdbId}`)}&format=json&origin=*`
  );
  const qid = search?.query?.search?.[0]?.title;
  if (!/^Q\d+$/.test(qid || "")) return null;
  const ent = await getJson(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`
  );
  return ent?.entities?.[qid]?.sitelinks?.enwiki?.title || null;
}

// The music part of the article: its "Music" / "Soundtrack" section, else the paragraphs that talk about songs.
async function articleMusicText(wikiTitle) {
  const data = await getJson(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(wikiTitle)}&format=json&origin=*`,
    9000
  );
  const page = Object.values(data?.query?.pages || {})[0];
  const text = String(page?.extract || "");
  if (!text) return "";
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
    if (m) {
      const level = m[1].length;
      if (current && level <= current.level) { sections.push(current); current = null; }
      if (!current && /\b(music|soundtrack|songs?)\b/i.test(m[2]) && !/\b(release|reception|award)/i.test(m[2])) current = { level, body: [] };
      else if (current) current.body.push(line);
    } else if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  let out = sections.map((x) => x.body.join("\n")).join("\n").trim();
  if (!out) {
    out = lines.filter((l) => /\b(song|theme song|soundtrack|performed by|singing|sung)\b/i.test(l) && l.length > 40).join("\n");
  }
  return out.slice(0, MAX_ARTICLE_CHARS);
}

async function extractSongs(text, title) {
  if (!process.env.GROQ_API_KEY) return [];
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: process.env.GROQ_SONGS_MODEL || "openai/gpt-oss-120b", // the one the rest of the backend already uses with Groq
      temperature: 0,
      max_tokens: 3000, // this model writes a reasoning trace first, which can use up a small budget before any answer
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You read a passage from a Wikipedia article about a TV series or film and list the existing songs that are heard IN THE PRODUCTION ITSELF " +
            "(licensed or original songs with a named artist, not the composer's score cues, not albums). Use ONLY what the passage says. " +
            "Leave out songs that belong to something else the passage talks about: a stage musical, a remake or sequel, a parody, a tribute, " +
            "a song that only references the title, or the production's later influence on music. For each song, \"evidence\" is the exact sentence " +
            "or phrase copied from the passage that says the song is in this production. If you cannot copy such a sentence, leave the song out. " +
            "\"artist\" is the performer ONLY if the passage says it, otherwise empty. " +
            "\"likely_artist\" is the performer of the recording this title is best known for, from what you know, or empty if unsure. " +
            'Answer as JSON: {"songs":[{"title":"...","artist":"...","likely_artist":"...","evidence":"..."}]} with at most 10 songs, or {"songs":[]} if none.',
        },
        { role: "user", content: `Title: ${title}\n\nPassage:\n${text}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const data = await res.json();
  let parsed;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { return []; }
  const list = Array.isArray(parsed.songs) ? parsed.songs : [];
  const haystack = norm(text);
  return list
    .map((x) => ({ title: cleanText(x?.title, 120), artist: cleanText(x?.artist, 120), likelyArtist: cleanText(x?.likely_artist, 120), evidence: norm(cleanText(x?.evidence, 400)) }))
    .filter((x) => x.title && norm(x.title).length > 1 && haystack.includes(norm(x.title))) // it has to be written in the article
    .filter((x) => x.evidence.length > 8 && haystack.includes(x.evidence) && x.evidence.includes(norm(x.title))) // and in a sentence that really is in the article, naming the song
    .slice(0, 10);
}

// A song on Deezer: the first result whose title and (when we have one) artist match what was asked for.
async function deezerSong(song) {
  const wantTitle = norm(song.title);
  const sameArtist = (t, name) => {
    const want = norm(name);
    const ta = norm(t.artist?.name);
    return !!want && (ta.includes(want) || want.includes(ta));
  };
  const titleOk = (t) => {
    const tt = norm(t.title_short || t.title);
    if (!(tt === wantTitle || tt.startsWith(`${wantTitle} `) || wantTitle.startsWith(`${tt} `))) return false;
    return !(NOT_WANTED.test(norm(t.title)) || NOT_WANTED.test(norm(t.album?.title)));
  };
  const search = async (q) => ((await deezer(`/search/track?q=${encodeURIComponent(q)}&limit=15`)).data || []).filter(titleOk);

  let hit = null;
  if (song.artist) {
    hit = (await search(`track:"${song.title}" artist:"${song.artist}"`)).find((t) => sameArtist(t, song.artist)) || null;
  } else {
    // The article names no performer, and a famous song has many versions (covers, other languages). Prefer the recording
    // the model knows from this title, else the most listened to one; Deezer's "rank" is its popularity number.
    const all = await search(`track:"${song.title}"`);
    const byRank = [...all].sort((x, y) => (y.rank || 0) - (x.rank || 0));
    if (song.likelyArtist) {
      hit = byRank.find((t) => sameArtist(t, song.likelyArtist)) || null;
      if (!hit) hit = (await search(`track:"${song.title}" artist:"${song.likelyArtist}"`)).find((t) => sameArtist(t, song.likelyArtist)) || null;
    }
    if (!hit) hit = byRank[0] || null;
  }
  if (!hit) return null;
  return {
    id: String(hit.id),
    title: hit.title_short || hit.title,
    artist: hit.artist?.name || song.artist || "",
    duration: hit.duration || 0,
    preview: typeof hit.preview === "string" && hit.preview.startsWith("https://") ? hit.preview : null,
    album: hit.album?.title || "",
    cover: cleanCover(hit.album?.cover_medium) || cleanCover(hit.album?.cover) || null,
  };
}

// ---- the exact YouTube video for a song (optional: needs YOUTUBE_API_KEY) ----
// A search link lands on whichever version YouTube ranks first. For the few songs of a title we look the video up once with
// YouTube's own API (a search costs 100 of the free 10,000 daily units), keep it for a month, and link straight to it.
// No key, no quota or any failure just means the song keeps its search link.
const YT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let ytPausedUntil = 0;
async function youtubeVideoId(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || Date.now() < ytPausedUntil) return null;
  const ck = `yt:${norm(query)}`;
  const cached = cacheGet(ck);
  if (cached !== undefined) return cached;
  try {
    const data = await getJson(
      `https://www.googleapis.com/youtube/v3/search?part=id&type=video&videoCategoryId=10&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`
    );
    const id = data?.items?.[0]?.id?.videoId;
    const value = /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    cacheSet(ck, value, YT_TTL_MS);
    return value;
  } catch (e) {
    if (/HTTP 403|HTTP 429/.test(String(e && e.message))) ytPausedUntil = Date.now() + 60 * 60 * 1000; // out of quota: stop for an hour
    return null;
  }
}

// Runs fn over items a few at a time (Deezer refuses bursts) and retries a failed one once. Never throws: a failure is reported
// as { failed: true } so the caller can tell "Deezer errored" from "Deezer has no such song".
async function lookupSongs(named) {
  const out = new Array(named.length);
  let next = 0;
  const worker = async () => {
    while (next < named.length) {
      const i = next++;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { out[i] = { value: await deezerSong(named[i]) }; break; }
        catch { out[i] = { failed: true }; await new Promise((r) => setTimeout(r, 400)); }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

async function featuredSongs(imdbId, title) {
  const key = `featured:v2:${imdbId}`; // v2: songs now need a quoted sentence from the article as evidence
  const cached = cacheGet(key);
  if (cached) return cached;
  const stored = await dbCacheGet(key, 90);
  if (Array.isArray(stored) && stored.length) { cacheSet(key, stored, FEATURED_TTL_MS); return stored; }
  let songs = [];
  let complete = false; // true only when nothing went wrong along the way
  try {
    const wikiTitle = await wikipediaTitleFor(imdbId);
    const text = wikiTitle ? await articleMusicText(wikiTitle) : "";
    const named = text ? await extractSongs(text, title) : [];
    const found = await lookupSongs(named);
    const seen = new Set();
    for (const f of found) {
      if (f.value && !seen.has(f.value.id)) { seen.add(f.value.id); songs.push(f.value); }
    }
    complete = !found.some((f) => f.failed);
    await Promise.all(songs.map(async (sg) => { sg.ytId = await youtubeVideoId(`${sg.title} ${sg.artist} ${title}`); }));
  } catch {
    return []; // a missing list is better than a wrong one, and not worth an error on screen; not cached, so the next open tries again
  }
  // A good list is kept for a week. When nothing was found it is kept 30 minutes, and when something failed only 15 seconds, so one bad moment (Deezer or Groq busy) is not remembered.
  cacheSet(key, songs, complete && songs.length ? FEATURED_TTL_MS : complete ? 30 * 60 * 1000 : 15 * 1000); // none found: 30 min; something failed: just 15 s
  if (complete && songs.length) await dbCacheSet(key, songs.map((sg) => ({ ...sg, preview: null }))); // preview links expire; a fresh one is fetched on play
  return songs;
}

async function albumTracks(albumId) {
  const key = `tracks:${albumId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  // From the shared cache the songs come without preview links (they expire): the app asks for a fresh one when a song is played.
  const stored = await dbCacheGet(key, DB_DAYS);
  if (Array.isArray(stored) && stored.length) { cacheSet(key, stored, TRACKS_TTL_MS); return stored; }
  if (isItunesId(albumId)) {
    const data = await itunes(`/lookup?id=${Number(albumId) - ITUNES_OFFSET}&entity=song&limit=200`);
    const tracks = (data.results || [])
      .filter((t) => t && t.wrapperType === "track" && t.trackId)
      .map((t) => ({
        id: String(t.trackId + ITUNES_OFFSET),
        title: t.trackName,
        artist: t.artistName || "",
        duration: t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
        preview: typeof t.previewUrl === "string" && t.previewUrl.startsWith("https://") ? t.previewUrl : null,
      }));
    cacheSet(key, tracks, TRACKS_TTL_MS);
    if (tracks.length) await dbCacheSet(key, tracks.map((t) => ({ ...t, preview: null })));
    return tracks;
  }
  const data = await deezer(`/album/${encodeURIComponent(albumId)}/tracks?limit=100`);
  const tracks = (data.data || [])
    .filter((t) => t && t.id)
    .map((t) => ({
      id: String(t.id),
      title: t.title_short || t.title,
      artist: t.artist?.name || "",
      duration: t.duration || null,
      preview: typeof t.preview === "string" && t.preview.startsWith("https://") ? t.preview : null,
    }));
  cacheSet(key, tracks, TRACKS_TTL_MS);
  if (tracks.length) await dbCacheSet(key, tracks.map((t) => ({ ...t, preview: null })));
  return tracks;
}

function shapeSaved(r) {
  return { trackId: String(r.track_id), title: r.track_title, artist: r.track_artist || "", album: r.album_title || "", cover: r.cover_url || null };
}

function mountSoundtracks(app, { requireAuth, asyncHandler }) {
  // Before the SQL in migrations/user_saved_tracks.sql has been run the table doesn't exist.
  const guard = (fn) =>
    asyncHandler(async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        if (e && e.code === "42P01") throw httpError(503, "Soundtracks aren't set up yet.");
        throw e;
      }
    });

  // Albums that look like this title's soundtrack, with the songs of the best one.
  app.get("/soundtrack", requireAuth, asyncHandler(async (req, res) => {
    const title = cleanText(req.query.title, 120);
    const originalTitle = cleanText(req.query.original_title, 120);
    if (!title && !originalTitle) throw httpError(400, "title is required");
    const year = parseInt(req.query.year, 10);
    const titles = [...new Set([originalTitle, title].filter(Boolean))];
    const composers = String(req.query.composer || "").split(",").map((c) => cleanText(c, 80)).filter(Boolean).slice(0, 4);
    const albums = await findAlbums(titles, Number.isInteger(year) ? year : null, composers);
    const tracks = albums[0] ? await albumTracks(albums[0].id) : [];
    res.json({ albums, albumId: albums[0]?.id || null, tracks });
  }));

  // Songs the title's Wikipedia article says are in it (see featuredSongs). Never an error: an empty list means "none known".
  app.get("/soundtrack/featured", requireAuth, asyncHandler(async (req, res) => {
    const imdbId = String(req.query.imdb_id || "");
    if (!/^tt\d{5,10}$/.test(imdbId)) return res.json({ songs: [] });
    res.json({ songs: await featuredSongs(imdbId, cleanText(req.query.title, 120)) });
  }));

  app.get("/soundtrack/album/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!/^\d{1,13}$/.test(req.params.id)) throw httpError(400, "Bad album id");
    res.json({ tracks: await albumTracks(req.params.id) });
  }));

  // A fresh 30 second preview link for one song (saved songs don't keep theirs: the links expire).
  app.get("/soundtrack/track/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!/^\d{1,13}$/.test(req.params.id)) throw httpError(400, "Bad track id");
    if (isItunesId(req.params.id)) {
      const d = await itunes(`/lookup?id=${Number(req.params.id) - ITUNES_OFFSET}`);
      const p = d.results?.[0]?.previewUrl;
      return res.json({ preview: typeof p === "string" && p.startsWith("https://") ? p : null });
    }
    const t = await deezer(`/track/${req.params.id}`);
    res.json({ preview: typeof t.preview === "string" && t.preview.startsWith("https://") ? t.preview : null });
  }));

  // Everything I saved, grouped by title, newest title first.
  app.get("/soundtrack/saved", requireAuth, guard(async (req, res) => {
    const { rows } = await getPool().query(
      `select kind, tmdb_id, media_title, poster_path, track_id, track_title, track_artist, album_title, cover_url, created_at
         from user_saved_tracks where user_id = $1 order by created_at desc`,
      [req.userId]
    );
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.kind}:${r.tmdb_id}`;
      if (!groups.has(key)) groups.set(key, { kind: r.kind, tmdbId: r.tmdb_id, title: r.media_title, posterPath: r.poster_path, tracks: [] });
      groups.get(key).tracks.push(shapeSaved(r));
    }
    res.json({ titles: [...groups.values()] });
  }));

  // Which songs of this title I already saved (for the filled marks in the list).
  app.get("/soundtrack/saved/ids", requireAuth, guard(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const tmdbId = parseInt(req.query.tmdb_id, 10);
    if (!kind || !Number.isInteger(tmdbId) || tmdbId <= 0) throw httpError(400, "kind and tmdb_id are required");
    const { rows } = await getPool().query(
      "select track_id from user_saved_tracks where user_id = $1 and kind = $2 and tmdb_id = $3",
      [req.userId, kind, tmdbId]
    );
    res.json({ trackIds: rows.map((r) => String(r.track_id)) });
  }));

  app.post("/soundtrack/saved", requireAuth, guard(async (req, res) => {
    const b = req.body || {};
    const kind = kindOf(b.kind);
    const tmdbId = parseInt(b.tmdb_id, 10);
    const mediaTitle = cleanText(b.title, 200);
    const trackId = /^\d{1,13}$/.test(String(b.track?.id ?? "")) ? String(b.track.id) : null;
    const trackTitle = cleanText(b.track?.title, 200);
    if (!kind || !Number.isInteger(tmdbId) || tmdbId <= 0 || !mediaTitle || !trackId || !trackTitle) throw httpError(400, "Missing fields");
    const pool = getPool();
    const { rows: cnt } = await pool.query("select count(*)::int as n from user_saved_tracks where user_id = $1", [req.userId]);
    if (cnt[0].n >= MAX_SAVED) throw httpError(400, `You can save up to ${MAX_SAVED} songs`);
    await pool.query(
      `insert into user_saved_tracks (user_id, kind, tmdb_id, track_id, media_title, poster_path, track_title, track_artist, album_title, cover_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (user_id, kind, tmdb_id, track_id) do nothing`,
      [req.userId, kind, tmdbId, trackId, mediaTitle, cleanPoster(b.poster_path), trackTitle,
        cleanText(b.track?.artist, 200) || null, cleanText(b.track?.album, 200) || null, cleanCover(b.track?.cover)]
    );
    res.status(201).json({ ok: true });
  }));

  // A link to a page with my saved songs (each opens in Spotify / YouTube Music). One token per person, reused; deleting it
  // turns the link off. The page itself is public, so the token is the only thing protecting it.
  app.post("/soundtrack/link", requireAuth, guard(async (req, res) => {
    const pool = getPool();
    const { rows } = await pool.query("select token from user_soundtrack_links where user_id = $1", [req.userId]);
    if (rows[0]) return res.json({ token: rows[0].token });
    const token = require("crypto").randomBytes(12).toString("base64url");
    await pool.query(
      "insert into user_soundtrack_links (user_id, token) values ($1, $2) on conflict (user_id) do nothing",
      [req.userId, token]
    );
    const { rows: again } = await pool.query("select token from user_soundtrack_links where user_id = $1", [req.userId]);
    res.json({ token: again[0].token });
  }));

  app.delete("/soundtrack/link", requireAuth, guard(async (req, res) => {
    await getPool().query("delete from user_soundtrack_links where user_id = $1", [req.userId]);
    res.json({ ok: true });
  }));

  // What the public page shows: song and artist, grouped by title. No names, no ids of the person.
  app.get("/public/soundtrack/:token", guard(async (req, res) => {
    const token = String(req.params.token || "");
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) throw httpError(404, "Not found");
    const { rows } = await getPool().query(
      `select t.kind, t.tmdb_id, t.media_title, t.track_title, t.track_artist
         from user_soundtrack_links l join user_saved_tracks t on t.user_id = l.user_id
        where l.token = $1 order by t.created_at desc`,
      [token]
    );
    const chk = rows.length ? true : (await getPool().query("select 1 from user_soundtrack_links where token = $1", [token])).rowCount > 0;
    if (!chk) throw httpError(404, "Not found");
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.kind}:${r.tmdb_id}`;
      if (!groups.has(key)) groups.set(key, { kind: r.kind, title: r.media_title, tracks: [] });
      groups.get(key).tracks.push({ title: r.track_title, artist: r.track_artist || "" });
    }
    res.set("Cache-Control", "no-store");
    res.json({ titles: [...groups.values()] });
  }));

  app.delete("/soundtrack/saved/:kind/:tmdbId/:trackId", requireAuth, guard(async (req, res) => {
    const kind = kindOf(req.params.kind);
    const tmdbId = parseInt(req.params.tmdbId, 10);
    if (!kind || !Number.isInteger(tmdbId) || !/^\d{1,13}$/.test(req.params.trackId)) throw httpError(400, "Bad request");
    await getPool().query(
      "delete from user_saved_tracks where user_id = $1 and kind = $2 and tmdb_id = $3 and track_id = $4",
      [req.userId, kind, tmdbId, req.params.trackId]
    );
    res.json({ ok: true });
  }));
}

module.exports = { mountSoundtracks, findAlbums, pinAlbums, albumTracks, debugAlbums, rankAlbum, featuredSongs, _extractSongs: extractSongs };
