// lists.js
// Custom lists: a person's own named collections of shows and movies ("the best of the best",
// "Korean for the weekend"), the way TV Time had them. Free for everyone.
//
// Sharing: a list is private until its owner switches "public" on. That gives it a short link,
//   GET /l/:slug   (no sign-in) a plain page with the list and a button to get Scenera,
// and makes it visible to the owner's friends (GET /friends/:connectionId/lists) and to anyone
// signed in who has the list id (GET /lists/:id). Turning it off removes the link; turning it on again
// issues the same link again.
//
// Tables: see migrations/user_lists.sql. Everything here goes through the direct Postgres pool.
const crypto = require("crypto");
const { getPool } = require("./db");

const MAX_LISTS = 50;
const MAX_ITEMS = 500;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const PLAY_URL = "https://play.google.com/store/apps/details?id=com.scenera.app";

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const cleanText = (s, max) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const cleanPoster = (p) => (typeof p === "string" && /^\/[A-Za-z0-9._-]{3,80}$/.test(p) ? p : null);

const newSlug = () => crypto.randomBytes(6).toString("base64url"); // 8 URL-safe characters

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Rows -> what the app gets. Never includes the owner's email.
function shapeList(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || "",
    isPublic: !!r.is_public,
    shareSlug: r.is_public ? r.share_slug : null,
    itemCount: Number(r.item_count || 0),
    covers: Array.isArray(r.covers) ? r.covers.filter(Boolean).slice(0, 4) : [],
    updatedAt: r.updated_at,
  };
}

const LIST_SUMMARY_SQL = `
  select l.id, l.name, l.description, l.is_public, l.share_slug, l.updated_at,
         count(i.tmdb_id)::int as item_count,
         (array_agg(i.poster_path order by i.position, i.added_at) filter (where i.poster_path is not null))[1:4] as covers
    from user_lists l
    left join user_list_items i on i.list_id = l.id
`;

async function loadItems(listId) {
  const { rows } = await getPool().query(
    "select kind, tmdb_id, title, poster_path from user_list_items where list_id = $1 order by position, added_at",
    [listId]
  );
  return rows.map((r) => ({ kind: r.kind, tmdbId: r.tmdb_id, title: r.title, posterPath: r.poster_path }));
}

async function ownerName(userId) {
  const { rows } = await getPool().query(
    "select raw_user_meta_data->>'display_name' as display_name from auth.users where id = $1",
    [userId]
  );
  return rows[0]?.display_name || null; // never the email
}

// The public page. Plain HTML, no scripts.
function renderPublicPage(list, items, owner) {
  const title = `${list.name} · Scenera`;
  const byline = owner ? `a list by ${esc(owner)}` : "a list on Scenera";
  const desc = list.description || `${items.length} ${items.length === 1 ? "title" : "titles"} · ${byline.replace(/<[^>]*>/g, "")}`;
  const firstPoster = items.find((i) => i.posterPath)?.posterPath;
  const og = firstPoster ? `https://image.tmdb.org/t/p/w500${firstPoster}` : "";
  const cards = items
    .map((i) => {
      const img = i.posterPath
        ? `<img src="https://image.tmdb.org/t/p/w342${esc(i.posterPath)}" alt="" loading="lazy" width="342" height="513">`
        : `<div class="ph"></div>`;
      return `<li>${img}<span>${esc(i.title)}</span><em>${i.kind === "movie" ? "Movie" : "TV show"}</em></li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(list.name)}">
<meta property="og:description" content="${esc(desc)}">
${og ? `<meta property="og:image" content="${esc(og)}">` : ""}
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b10; color: #f3f3f7; font: 16px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 28px 16px 56px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  .by { color: #9a9aab; margin: 0 0 6px; font-size: 14px; }
  .desc { color: #c9c9d6; margin: 10px 0 0; }
  ul { list-style: none; margin: 24px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 16px 12px; }
  li img, .ph { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 10px; background: #1a1a24; display: block; }
  li span { display: block; margin-top: 6px; font-size: 13px; font-weight: 600; }
  li em { color: #8a8a9c; font-style: normal; font-size: 12px; }
  .cta { display: block; margin: 28px 0 0; padding: 14px 18px; text-align: center; background: #7c5cff; color: #fff; border-radius: 12px; font-weight: 700; text-decoration: none; }
  .note { color: #8a8a9c; font-size: 12px; margin-top: 28px; }
  .empty { color: #9a9aab; margin-top: 24px; }
</style></head>
<body><main>
<h1>${esc(list.name)}</h1>
<p class="by">${byline} · ${items.length} ${items.length === 1 ? "title" : "titles"}</p>
${list.description ? `<p class="desc">${esc(list.description)}</p>` : ""}
${items.length ? `<ul>${cards}</ul>` : `<p class="empty">This list is empty for now.</p>`}
<a class="cta" href="${PLAY_URL}&amp;referrer=utm_source%3Dlist_share%26utm_medium%3Dweb">Track your shows and movies with Scenera (Android)</a>
<p class="note">This product uses the TMDB API but is not endorsed or certified by TMDB. Posters and titles: TMDB.</p>
</main></body></html>`;
}

function mountLists(app, { supabase, requireAuth, asyncHandler }) {
  // Before the SQL in migrations/user_lists.sql has been run the tables don't exist.
  const guard = (fn) =>
    asyncHandler(async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        if (e && e.code === "42P01") throw httpError(503, "Lists aren't set up yet.");
        throw e;
      }
    });

  async function ownList(listId, userId) {
    if (!isUuid(listId)) throw httpError(404, "List not found");
    const { rows } = await getPool().query("select * from user_lists where id = $1 and user_id = $2", [listId, userId]);
    if (!rows[0]) throw httpError(404, "List not found");
    return rows[0];
  }

  // My lists, newest activity first.
  app.get("/lists", requireAuth, guard(async (req, res) => {
    const { rows } = await getPool().query(
      `${LIST_SUMMARY_SQL} where l.user_id = $1 group by l.id order by l.updated_at desc`,
      [req.userId]
    );
    res.json({ lists: rows.map(shapeList) });
  }));

  // Which of my lists already hold this title (for the checkmarks in "Add to list").
  app.get("/lists/containing", requireAuth, guard(async (req, res) => {
    const kind = req.query.kind === "movie" ? "movie" : "show";
    const tmdbId = parseInt(req.query.tmdb_id, 10);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw httpError(400, "tmdb_id is required");
    const { rows } = await getPool().query(
      `select i.list_id from user_list_items i join user_lists l on l.id = i.list_id
        where l.user_id = $1 and i.kind = $2 and i.tmdb_id = $3`,
      [req.userId, kind, tmdbId]
    );
    res.json({ listIds: rows.map((r) => r.list_id) });
  }));

  app.post("/lists", requireAuth, guard(async (req, res) => {
    const name = cleanText(req.body?.name, MAX_NAME);
    if (!name) throw httpError(400, "Give the list a name");
    const description = cleanText(req.body?.description, MAX_DESCRIPTION) || null;
    const pool = getPool();
    const { rows: cnt } = await pool.query("select count(*)::int as n from user_lists where user_id = $1", [req.userId]);
    if (cnt[0].n >= MAX_LISTS) throw httpError(400, `You can have up to ${MAX_LISTS} lists`);
    const { rows } = await pool.query(
      "insert into user_lists (user_id, name, description) values ($1, $2, $3) returning id",
      [req.userId, name, description]
    );
    const { rows: out } = await pool.query(`${LIST_SUMMARY_SQL} where l.id = $1 group by l.id`, [rows[0].id]);
    res.status(201).json({ list: shapeList(out[0]) });
  }));

  // One list with its items: the owner, or anyone signed in when it is public.
  app.get("/lists/:id", requireAuth, guard(async (req, res) => {
    if (!isUuid(req.params.id)) throw httpError(404, "List not found");
    const { rows } = await getPool().query(`${LIST_SUMMARY_SQL} where l.id = $1 group by l.id`, [req.params.id]);
    const row = rows[0];
    if (!row) throw httpError(404, "List not found");
    const { rows: own } = await getPool().query("select user_id from user_lists where id = $1", [req.params.id]);
    const isOwner = own[0]?.user_id === req.userId;
    if (!isOwner && !row.is_public) throw httpError(404, "List not found");
    const items = await loadItems(req.params.id);
    res.json({
      list: shapeList(row),
      items,
      isOwner,
      owner: isOwner ? null : await ownerName(own[0].user_id),
    });
  }));

  app.patch("/lists/:id", requireAuth, guard(async (req, res) => {
    const list = await ownList(req.params.id, req.userId);
    const sets = [];
    const vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (req.body?.name !== undefined) {
      const name = cleanText(req.body.name, MAX_NAME);
      if (!name) throw httpError(400, "Give the list a name");
      add("name", name);
    }
    if (req.body?.description !== undefined) add("description", cleanText(req.body.description, MAX_DESCRIPTION) || null);
    if (req.body?.is_public !== undefined) {
      const pub = !!req.body.is_public;
      add("is_public", pub);
      if (pub && !list.share_slug) add("share_slug", newSlug()); // kept once issued, so the same link comes back
    }
    if (!sets.length) throw httpError(400, "Nothing to change");
    add("updated_at", new Date().toISOString());
    vals.push(list.id);
    await getPool().query(`update user_lists set ${sets.join(", ")} where id = $${vals.length}`, vals);
    const { rows } = await getPool().query(`${LIST_SUMMARY_SQL} where l.id = $1 group by l.id`, [list.id]);
    res.json({ list: shapeList(rows[0]) });
  }));

  app.delete("/lists/:id", requireAuth, guard(async (req, res) => {
    const list = await ownList(req.params.id, req.userId);
    await getPool().query("delete from user_lists where id = $1", [list.id]); // items go with it (on delete cascade)
    res.json({ ok: true });
  }));

  app.post("/lists/:id/items", requireAuth, guard(async (req, res) => {
    const list = await ownList(req.params.id, req.userId);
    const kind = req.body?.kind === "movie" ? "movie" : req.body?.kind === "show" ? "show" : null;
    const tmdbId = parseInt(req.body?.tmdb_id, 10);
    const title = cleanText(req.body?.title, 200);
    if (!kind || !Number.isInteger(tmdbId) || tmdbId <= 0 || !title) throw httpError(400, "kind, tmdb_id and title are required");
    const pool = getPool();
    const { rows: cnt } = await pool.query("select count(*)::int as n, coalesce(max(position), 0) as top from user_list_items where list_id = $1", [list.id]);
    if (cnt[0].n >= MAX_ITEMS) throw httpError(400, `A list can hold up to ${MAX_ITEMS} titles`);
    await pool.query(
      `insert into user_list_items (list_id, kind, tmdb_id, title, poster_path, position)
       values ($1, $2, $3, $4, $5, $6) on conflict (list_id, kind, tmdb_id) do nothing`,
      [list.id, kind, tmdbId, title, cleanPoster(req.body?.poster_path), Number(cnt[0].top) + 1]
    );
    await pool.query("update user_lists set updated_at = now() where id = $1", [list.id]);
    res.status(201).json({ ok: true });
  }));

  app.delete("/lists/:id/items/:kind/:tmdbId", requireAuth, guard(async (req, res) => {
    const list = await ownList(req.params.id, req.userId);
    const kind = req.params.kind === "movie" ? "movie" : "show";
    const tmdbId = parseInt(req.params.tmdbId, 10);
    if (!Number.isInteger(tmdbId)) throw httpError(400, "Bad id");
    await getPool().query("delete from user_list_items where list_id = $1 and kind = $2 and tmdb_id = $3", [list.id, kind, tmdbId]);
    await getPool().query("update user_lists set updated_at = now() where id = $1", [list.id]);
    res.json({ ok: true });
  }));

  // A friend's public lists.
  app.get("/friends/:connectionId/lists", requireAuth, guard(async (req, res) => {
    const { data: row } = await supabase.from("friend_connections").select("*").eq("id", req.params.connectionId).maybeSingle();
    if (!row || row.status !== "accepted") throw httpError(404, "Not an accepted friend connection");
    if (row.requester_id !== req.userId && row.recipient_id !== req.userId) throw httpError(403, "Not your connection");
    const friendId = row.requester_id === req.userId ? row.recipient_id : row.requester_id;
    const { rows } = await getPool().query(
      `${LIST_SUMMARY_SQL} where l.user_id = $1 and l.is_public group by l.id order by l.updated_at desc`,
      [friendId]
    );
    res.json({ lists: rows.map(shapeList) });
  }));

  // The shared link. No sign-in. Unknown or switched-off links look the same.
  app.get("/l/:slug", asyncHandler(async (req, res) => {
    const slug = String(req.params.slug || "");
    let list = null;
    if (/^[A-Za-z0-9_-]{6,16}$/.test(slug)) {
      try {
        const { rows } = await getPool().query("select * from user_lists where share_slug = $1 and is_public", [slug]);
        list = rows[0] || null;
      } catch (e) {
        if (e.code !== "42P01") throw e;
      }
    }
    res.set("Cache-Control", "public, max-age=120");
    // helmet's default policy only allows our own images; this page shows TMDB posters and needs its inline style.
    res.set("Content-Security-Policy", "default-src 'none'; img-src https://image.tmdb.org; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    if (!list) {
      res.status(404).type("html").send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>List not found · Scenera</title><body style="font-family:system-ui;background:#0b0b10;color:#f3f3f7;padding:32px"><h1>This list isn't available</h1><p>It may have been made private or deleted.</p><p><a style="color:#a99bff" href="${PLAY_URL}">Get Scenera for Android</a></p></body>`
      );
      return;
    }
    const [items, owner] = await Promise.all([loadItems(list.id), ownerName(list.user_id)]);
    res.type("html").send(renderPublicPage(list, items, owner));
  }));
}

module.exports = { mountLists, renderPublicPage };
