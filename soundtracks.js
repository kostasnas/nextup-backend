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
    return url.protocol === "https:" && url.hostname.endsWith(".dzcdn.net") ? url.toString().slice(0, 300) : null;
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

async function findAlbums(titles, year) {
  const wanted = titles.map(norm).filter(Boolean);
  if (!wanted.length) return [];
  const key = `albums:${wanted.join("|")}:${year || ""}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Two angles per title: albums whose name contains it, and a plain "<title> soundtrack" search.
  const queries = [];
  for (const t of titles.filter(Boolean)) {
    queries.push(`/search/album?q=${encodeURIComponent(`album:"${t}"`)}&limit=25`);
    queries.push(`/search/album?q=${encodeURIComponent(`${t} soundtrack`)}&limit=25`);
  }
  const settled = await Promise.allSettled(queries.map((q) => deezer(q)));
  if (settled.every((s) => s.status === "rejected")) throw settled[0].reason;

  const byId = new Map();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const a of s.value.data || []) if (a && a.id && !byId.has(a.id)) byId.set(a.id, a);
  }
  const candidates = [...byId.values()]
    .map((a) => ({ a, score: rankAlbum(a, wanted) + (year && String(a.release_date || "").startsWith(String(year)) ? 1 : 0) }))
    .filter((x) => x.score >= 8) // title in the name AND it looks like a soundtrack/score
    .sort((x, y) => y.score - x.score || (y.a.nb_tracks || 0) - (x.a.nb_tracks || 0));
  // Albums that call themselves the original soundtrack win. Only when there are none (older or obscure titles) do the
  // looser matches show up, and then just the best few.
  // The title has to open the album's name: "Severance: Season 1 (Original Series Soundtrack)" is the show's, while
  // "Life On Earth: Severance (Original Series Soundtrack)" is another series that only mentions the word.
  const opens = (a) => wanted.some((t) => norm(a.title).startsWith(t));
  const official = candidates.filter((x) => isOfficial(x.a));
  const officialOpening = official.filter((x) => opens(x.a));
  const chosen = officialOpening.length ? officialOpening.slice(0, 5)
    : official.length ? official.slice(0, 5)
    : candidates.slice(0, 3);
  const ranked = chosen
    .map(({ a }) => ({
      id: String(a.id),
      title: a.title,
      artist: a.artist?.name || "",
      cover: cleanCover(a.cover_medium) || cleanCover(a.cover) || null,
      trackCount: a.nb_tracks || null,
    }));
  cacheSet(key, ranked, SEARCH_TTL_MS);
  return ranked;
}

async function albumTracks(albumId) {
  const key = `tracks:${albumId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
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
    const albums = await findAlbums(titles, Number.isInteger(year) ? year : null);
    const tracks = albums[0] ? await albumTracks(albums[0].id) : [];
    res.json({ albums, albumId: albums[0]?.id || null, tracks });
  }));

  app.get("/soundtrack/album/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!/^\d{1,12}$/.test(req.params.id)) throw httpError(400, "Bad album id");
    res.json({ tracks: await albumTracks(req.params.id) });
  }));

  // A fresh 30 second preview link for one song (saved songs don't keep theirs: the links expire).
  app.get("/soundtrack/track/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!/^\d{1,12}$/.test(req.params.id)) throw httpError(400, "Bad track id");
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
    const trackId = /^\d{1,12}$/.test(String(b.track?.id ?? "")) ? String(b.track.id) : null;
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

  app.delete("/soundtrack/saved/:kind/:tmdbId/:trackId", requireAuth, guard(async (req, res) => {
    const kind = kindOf(req.params.kind);
    const tmdbId = parseInt(req.params.tmdbId, 10);
    if (!kind || !Number.isInteger(tmdbId) || !/^\d{1,12}$/.test(req.params.trackId)) throw httpError(400, "Bad request");
    await getPool().query(
      "delete from user_saved_tracks where user_id = $1 and kind = $2 and tmdb_id = $3 and track_id = $4",
      [req.userId, kind, tmdbId, req.params.trackId]
    );
    res.json({ ok: true });
  }));
}

module.exports = { mountSoundtracks, findAlbums, rankAlbum };
