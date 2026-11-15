// tvmazeCast.js
// GET /tvmaze/cast?imdb=tt1234567[&tvdb=12345] — the cast of a show as TVmaze lists it, which (unlike TMDB)
// carries a picture of the CHARACTER as well as of the actor. The app uses it on the show page so the cast
// row can show Lagertha instead of only Katheryn Winnick; anything missing falls back to the actor photo.
//
// The show is found through its IMDb id (TVDB id as a second try). Answers are kept for 24 hours, and a
// "not found / failed" answer for 1 hour, so a show TVmaze doesn't know does not cost a request per visit.
// Never throws to the app: on any problem it answers { cast: [] } and the app keeps its current cast row.

const { getPool } = require("./db");

const BASE = "https://api.tvmaze.com";
const DB_TTL_OK_MS = 30 * 24 * 60 * 60 * 1000;
const DB_TTL_EMPTY_MS = 24 * 60 * 60 * 1000;
const TTL_OK_MS = 24 * 60 * 60 * 1000;
const TTL_EMPTY_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const TIMEOUT_MS = 8000;

const cache = new Map(); // key -> { data, expiresAt }

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(key); return null; }
  return hit.data;
}
function writeCache(key, data) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiresAt: Date.now() + (data.cast.length ? TTL_OK_MS : TTL_EMPTY_MS) });
}

// Second-level cache in Postgres (table tvmaze_cast_cache, see migrations/). Every failure here is swallowed:
// if the table doesn't exist yet or the database is busy, we simply go to TVmaze as before.
async function readDb(key) {
  try {
    const { rows } = await getPool().query("select cast_json, fetched_at from tvmaze_cast_cache where cache_key = $1", [key]);
    const row = rows[0];
    if (!row) return null;
    const list = Array.isArray(row.cast_json) ? row.cast_json : [];
    const ttl = list.length ? DB_TTL_OK_MS : DB_TTL_EMPTY_MS;
    if (Date.now() - new Date(row.fetched_at).getTime() > ttl) return null;
    return { cast: list };
  } catch { return null; }
}
async function writeDb(key, data) {
  try {
    await getPool().query(
      "insert into tvmaze_cast_cache (cache_key, cast_json, fetched_at) values ($1, $2::jsonb, now()) on conflict (cache_key) do update set cast_json = excluded.cast_json, fetched_at = now()",
      [key, JSON.stringify(data.cast)]
    );
  } catch { /* cache only */ }
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  return r.json();
}

const https = (u) => (typeof u === "string" ? u.replace(/^http:\/\//, "https://") : null);

async function findShowId(imdb, tvdb) {
  if (imdb) {
    const s = await getJson(`${BASE}/lookup/shows?imdb=${encodeURIComponent(imdb)}`).catch(() => null);
    if (s && s.id) return s.id;
  }
  if (tvdb) {
    const s = await getJson(`${BASE}/lookup/shows?thetvdb=${encodeURIComponent(tvdb)}`).catch(() => null);
    if (s && s.id) return s.id;
  }
  return null;
}

async function tvmazeCast(req, res) {
  const imdb = /^tt\d{5,12}$/.test(String(req.query.imdb || "")) ? String(req.query.imdb) : "";
  const tvdb = /^\d{1,10}$/.test(String(req.query.tvdb || "")) ? String(req.query.tvdb) : "";
  if (!imdb && !tvdb) return res.status(400).json({ error: "imdb or tvdb required" });

  const key = `${imdb}|${tvdb}`;
  const cached = readCache(key);
  if (cached) return res.json(cached);

  const stored = await readDb(key);
  if (stored) { writeCache(key, stored); res.set("Cache-Control", "public, max-age=3600"); return res.json(stored); }

  let data = { cast: [] };
  let reached = false;
  try {
    const id = await findShowId(imdb, tvdb);
    const rows = id ? await getJson(`${BASE}/shows/${id}/cast`) : null;
    reached = Boolean(id);
    if (Array.isArray(rows)) {
      data = {
        cast: rows
          .filter((r) => r && r.person && r.character && r.character.name)
          .map((r) => ({
            actor: r.person.name,
            character: r.character.name,
            characterImage: https(r.character.image && r.character.image.medium),
          }))
          .filter((r) => r.characterImage),
      };
    }
  } catch (e) {
    // fall through with an empty answer; it is cached only briefly
  }
  writeCache(key, data);
  // Remember in the database only when TVmaze actually answered (a timeout must not be stored as "no cast").
  if (reached) await writeDb(key, data);
  res.set("Cache-Control", "public, max-age=3600");
  res.json(data);
}

module.exports = { tvmazeCast };
