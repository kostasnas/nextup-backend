// topMovies.js
// "My Top 10": one ranked list of up to 10 movies per year (year 0 = all time), like Letterboxd.
//
//   (the same routes exist for series under /top-shows, tables user_top_show_*)
//   GET    /top-movies          my lists, newest year first, "all time" last
//   PUT    /top-movies/:year    replace one list { items: [{ tmdbId, title, posterPath, releaseYear }], isPublic, label }
//   DELETE /top-movies/:year    remove one list
//   GET    /users/:id/top-movies  someone else's lists: only the ones they switched on for followers, and only
//                                 for people who follow them (public profile, nobody blocked)
//
// Tables: see migrations/top_movies.sql. Everything goes through the direct Postgres pool.
const { getPool } = require("./db");

const MAX_ITEMS = 10;

// Movies and series use identical tables apart from their names.
const KINDS = {
  movies: { lists: "user_top_movie_lists", items: "user_top_movies", path: "top-movies" },
  shows: { lists: "user_top_show_lists", items: "user_top_shows", path: "top-shows" },
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const cleanTitle = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 200) : "");
const cleanPoster = (p) => (typeof p === "string" && /^\/[A-Za-z0-9._-]{3,80}$/.test(p) ? p : null);

function parseYear(v) {
  const y = parseInt(v, 10);
  if (!Number.isInteger(y) || !(y === 0 || (y >= 1900 && y <= 2100) || (y >= 190001 && y <= 210099))) throw httpError(400, "Invalid year");
  return y;
}

const sortVal = (key) => (key >= 10000 ? Math.floor(key / 100) : key);

async function loadLists(K, userId, onlyPublic) {
  const pool = getPool();
  const [lists, items] = await Promise.all([
    pool.query(
      `select year, label, is_public, updated_at from ${K.lists} where user_id = $1 ${onlyPublic ? "and is_public = true" : ""}`,
      [userId]
    ),
    pool.query(
      `select year, position, tmdb_id, title, poster_path, release_year from ${K.items} where user_id = $1 order by year, position`,
      [userId]
    ),
  ]);
  const byYear = new Map();
  for (const r of lists.rows) byYear.set(r.year, { year: r.year, label: r.label || null, isPublic: !!r.is_public, updatedAt: r.updated_at, items: [] });
  for (const r of items.rows) {
    const l = byYear.get(r.year);
    if (l) l.items.push({ tmdbId: r.tmdb_id, title: r.title, posterPath: r.poster_path, releaseYear: r.release_year });
  }
  // Newest year first, "all time" (0) last. Empty lists are kept for the owner and hidden from followers.
  return [...byYear.values()]
    .filter((l) => !onlyPublic || l.items.length > 0)
    .sort((a, b) => (a.year === 0 ? 1 : b.year === 0 ? -1 : sortVal(b.year) - sortVal(a.year) || b.year - a.year));
}

function mountTopMovies(app, { requireAuth, asyncHandler }) {
  const guard = (fn) =>
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        res.json(await fn(req));
      } catch (e) {
        if (e && e.code === "42P01") return res.status(503).json({ error: "Top 10 isn't set up yet." });
        if (e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    });

  for (const K of Object.values(KINDS)) {
    app.get(`/${K.path}`, requireAuth, guard(async (req) => ({ lists: await loadLists(K, req.userId, false) })));

    app.put(`/${K.path}/:year`, requireAuth, guard(async (req) => {
      const year = parseYear(req.params.year);
      const raw = Array.isArray(req.body?.items) ? req.body.items : [];
      const seen = new Set();
      const items = [];
      for (const it of raw) {
        const tmdbId = parseInt(it?.tmdbId, 10);
        const title = cleanTitle(it?.title);
        if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !title || seen.has(tmdbId)) continue;
        seen.add(tmdbId);
        const ry = parseInt(it?.releaseYear, 10);
        items.push({ tmdbId, title, posterPath: cleanPoster(it?.posterPath), releaseYear: Number.isInteger(ry) && ry > 1800 && ry < 2200 ? ry : null });
      }
      if (items.length > MAX_ITEMS) throw httpError(400, `A Top ${MAX_ITEMS} holds up to ${MAX_ITEMS} movies`);
      const isPublic = req.body?.isPublic === true;
      const label = year !== 0 && typeof req.body?.label === "string" ? cleanTitle(req.body.label).slice(0, 12) || null : null;
      const client = await getPool().connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into ${K.lists} (user_id, year, is_public, label) values ($1, $2, $3, $4)
             on conflict (user_id, year) do update set is_public = excluded.is_public, label = excluded.label, updated_at = now()`,
          [req.userId, year, isPublic, label]
        );
        await client.query(`delete from ${K.items} where user_id = $1 and year = $2`, [req.userId, year]);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await client.query(
            `insert into ${K.items} (user_id, year, position, tmdb_id, title, poster_path, release_year) values ($1, $2, $3, $4, $5, $6, $7)`,
            [req.userId, year, i + 1, it.tmdbId, it.title, it.posterPath, it.releaseYear]
          );
        }
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      return { ok: true };
    }));

    app.delete(`/${K.path}/:year`, requireAuth, guard(async (req) => {
      const year = parseYear(req.params.year);
      await getPool().query(`delete from ${K.lists} where user_id = $1 and year = $2`, [req.userId, year]);
      return { ok: true };
    }));

    // Someone else's Top 10: only for their followers, only the lists they switched on.
    app.get(`/users/:id/${K.path}`, requireAuth, guard(async (req) => {
      const ownerId = String(req.params.id || "").toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ownerId)) throw httpError(404, "Profile not found");
      if (ownerId === req.userId) return { lists: await loadLists(K, ownerId, false) };
      const { readVisibleUser } = require("./follows");
      await readVisibleUser(req.userId, ownerId); // 404 when the profile is private or blocked
      const f = await getPool().query("select 1 from follows where follower_id = $1 and followed_id = $2", [req.userId, ownerId]);
      if (f.rows.length === 0) return { lists: [] };
      return { lists: await loadLists(K, ownerId, true) };
    }));
  }
}

module.exports = { mountTopMovies };
