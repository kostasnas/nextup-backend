// communitySuggest.js
// Community suggestions: one shared, anonymous list of series and movies. Anyone can add a title ("Suggest to
// everyone"); everyone else gets a weekly set of picks, can add titles to planned, hide them, and rate them. A rating
// is seen only by the people who suggested the title; the score and level show on their profile.
//
//   POST   /community/suggest              { kind, tmdbId, title, posterPath, releaseYear }  (max 10 a day)
//   DELETE /community/suggest/:kind/:tmdbId  take my suggestion back
//   GET    /community/suggested?kind&tmdbId  did I suggest this title?
//   GET    /community/picks?kind             this week's picks for me (frozen per week)
//   GET    /community/browse?kind&filter&offset  all suggestions of the last 30 days (filter: popular | new); a title I
//                                          hid or rated never comes back for me, whoever suggests it again
//   POST   /community/:id/dismiss  (DELETE = undo)   "Not for me"
//   POST   /community/:id/added      I added it to my planned list (tells the suggesters at milestones)
//   POST   /community/:id/rate       { rating: 1-5 }  only for titles on my own list
//   GET    /community/mine           my suggestions with their stats + my summary
//   GET    /community/profile/:userId  someone's badge and score (public profiles only)
//
// Tables: see migrations/community_suggestions.sql. Everything goes through the direct Postgres pool.
const { getPool } = require("./db");

const DAILY_LIMIT = 10;
const WINDOW_DAYS = 30; // a suggestion that gets no new suggester for this long drops out of the lists
const PICKS = 10;
const MIN_FOR_BATCH = 5; // a week's picks are frozen only once there are at least this many to choose from
const BROWSE_PAGE = 20;
const MILESTONES = [3, 10, 25, 50, 100, 250, 500]; // "N people added ..." notifications
const LEVELS = [10, 25, 50, 100, 250]; // adds by other people needed for level 1..5 (Pilot, Series Regular, Showrunner, Executive Producer, Hall of Fame)
const MONTHLY_MIN_ADDS = 3; // a monthly "Top Suggester" title needs at least this many adds that month
const MIN_RATINGS_FOR_SCORE = 3;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const cleanTitle = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 200) : "");
const cleanPoster = (p) => (typeof p === "string" && /^\/[A-Za-z0-9._-]{3,80}$/.test(p) ? p : null);
const parseKind = (v) => {
  if (v === "tv" || v === "movie") return v;
  throw httpError(400, "Invalid kind");
};
const parseId = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, "Invalid id");
  return n;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Is this title on the person's own list (any status)?
async function onMyList(userId, kind, tmdbId) {
  const sql = kind === "tv"
    ? "select 1 from user_watchlist w join shows s on s.id = w.show_id where w.user_id = $1 and s.tmdb_id = $2 limit 1"
    : "select 1 from user_movie_watchlist w join movies m on m.id = w.movie_id where w.user_id = $1 and m.tmdb_id = $2 limit 1";
  const { rows } = await getPool().query(sql, [userId, tmdbId]);
  return rows.length > 0;
}

// Adds "inList" / my response to suggestion rows. Column names are fixed here, never user input.
const IN_LIST_SQL = `case when s.kind = 'tv'
    then exists(select 1 from user_watchlist w join shows sh on sh.id = w.show_id where w.user_id = $1 and sh.tmdb_id = s.tmdb_id)
    else exists(select 1 from user_movie_watchlist w join movies m on m.id = w.movie_id where w.user_id = $1 and m.tmdb_id = s.tmdb_id)
  end`;
const LIST_COLUMNS_IN_LIST = IN_LIST_SQL;
const LIST_COLUMNS = `s.id, s.kind, s.tmdb_id, s.title, s.poster_path, s.release_year, s.suggest_count,
  coalesce(r.added, false) as added, coalesce(r.dismissed, false) as dismissed, r.rating as my_rating,
  case when s.kind = 'tv'
    then exists(select 1 from user_watchlist w join shows sh on sh.id = w.show_id where w.user_id = $1 and sh.tmdb_id = s.tmdb_id)
    else exists(select 1 from user_movie_watchlist w join movies m on m.id = w.movie_id where w.user_id = $1 and m.tmdb_id = s.tmdb_id)
  end as in_list,
  case when s.kind = 'tv'
    then (select w.status from user_watchlist w join shows sh on sh.id = w.show_id where w.user_id = $1 and sh.tmdb_id = s.tmdb_id limit 1)
    else (select w.status from user_movie_watchlist w join movies m on m.id = w.movie_id where w.user_id = $1 and m.tmdb_id = s.tmdb_id limit 1)
  end as list_status`;
const LIST_FROM = "community_suggestions s left join community_responses r on r.suggestion_id = s.id and r.user_id = $1";
// Titles I did not suggest myself.
const NOT_MINE = "not exists (select 1 from community_suggesters x where x.suggestion_id = s.id and x.user_id = $1)";

const shape = (r) => ({
  id: Number(r.id), kind: r.kind, tmdbId: r.tmdb_id, title: r.title, posterPath: r.poster_path, releaseYear: r.release_year,
  suggestCount: r.suggest_count, added: !!r.added, inList: !!r.in_list, listStatus: r.list_status || null, myRating: r.my_rating || null,
});

function nextMonday() {
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  const next = new Date(start.getTime() + 7 * 86400000);
  return { weekStart: start.toISOString().slice(0, 10), daysLeft: Math.max(1, Math.ceil((next - now) / 86400000)) };
}

async function notify(userIds, { type, title, body, data }) {
  if (!userIds.length) return;
  try {
    const pool = getPool();
    for (const uid of userIds) {
      if (type === "community_added") {
        // One line per title: the newer count replaces the older one.
        await pool.query("delete from notifications where user_id = $1 and type = $2 and data->>'suggestionId' = $3", [uid, type, String(data.suggestionId)]);
      }
      await pool.query("insert into notifications (user_id, type, title, body, data) values ($1, $2, $3, $4, $5::jsonb)", [uid, type, title, body, JSON.stringify(data)]);
    }
  } catch (e) {
    console.error("community notify failed:", e.message); // a notification must never break the request
  }
}

async function suggesterIds(suggestionId) {
  const { rows } = await getPool().query("select user_id from community_suggesters where suggestion_id = $1", [suggestionId]);
  return rows.map((r) => r.user_id);
}

// Adds by other people (not the suggesters themselves) and ratings, for the given suggestion ids.
async function statsFor(ids) {
  if (!ids.length) return new Map();
  const { rows } = await getPool().query(
    `select r.suggestion_id, count(*) filter (where r.added)::int as added, count(r.rating)::int as rated,
            avg(r.rating)::float as avg,
            count(*) filter (where r.rating = 1)::int as s1, count(*) filter (where r.rating = 2)::int as s2,
            count(*) filter (where r.rating = 3)::int as s3, count(*) filter (where r.rating = 4)::int as s4,
            count(*) filter (where r.rating = 5)::int as s5
       from community_responses r
      where r.suggestion_id = any($1::bigint[])
        and not exists (select 1 from community_suggesters x where x.suggestion_id = r.suggestion_id and x.user_id = r.user_id)
      group by r.suggestion_id`,
    [ids]
  );
  return new Map(rows.map((r) => [Number(r.suggestion_id), {
    added: r.added, rated: r.rated, avg: r.rated >= MIN_RATINGS_FOR_SCORE ? Math.round(r.avg * 10) / 10 : null,
    hist: { 1: r.s1, 2: r.s2, 3: r.s3, 4: r.s4, 5: r.s5 },
  }]));
}

// Top 3 suggesters of the last full calendar month (UTC), by adds from other people in that month. Cached for 10 minutes.
let monthlyCache = { key: "", at: 0, rows: [] };
function lastMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end, key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}` };
}
async function monthlyTop() {
  const { start, end, key } = lastMonthRange();
  if (monthlyCache.key === key && Date.now() - monthlyCache.at < 600000) return monthlyCache;
  const { rows } = await getPool().query(
    `select c.user_id, count(*)::int as adds
       from community_responses r
       join community_suggesters c on c.suggestion_id = r.suggestion_id
      where r.added and r.added_at >= $1 and r.added_at < $2 and r.user_id <> c.user_id
        and not exists (select 1 from community_suggesters x where x.suggestion_id = r.suggestion_id and x.user_id = r.user_id)
      group by c.user_id having count(*) >= $3
      order by adds desc, c.user_id limit 3`,
    [start, end, MONTHLY_MIN_ADDS]
  );
  monthlyCache = { key, at: Date.now(), rows: rows.map((r, i) => ({ userId: r.user_id, rank: i + 1 })) };
  return monthlyCache;
}

async function summaryFor(userId) {
  const { rows } = await getPool().query(
    `select s.id, s.kind, s.tmdb_id, s.title, s.poster_path from community_suggesters c
       join community_suggestions s on s.id = c.suggestion_id where c.user_id = $1`,
    [userId]
  );
  const stats = await statsFor(rows.map((r) => Number(r.id)));
  let addedTotal = 0, ratingSum = 0, ratingCount = 0;
  const items = rows.map((r) => {
    const st = stats.get(Number(r.id)) || { added: 0, rated: 0, avg: null, hist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    addedTotal += st.added;
    if (st.rated > 0) {
      // Weighted by the real average of every rating, not the hidden-below-3 one.
      const h = st.hist;
      ratingSum += h[1] + 2 * h[2] + 3 * h[3] + 4 * h[4] + 5 * h[5];
      ratingCount += st.rated;
    }
    return { id: Number(r.id), kind: r.kind, tmdbId: r.tmdb_id, title: r.title, posterPath: r.poster_path, ...st };
  });
  const level = LEVELS.filter((n) => addedTotal >= n).length;
  const mt = (await monthlyTop().catch(() => null));
  const monthRank = mt ? mt.rows.find((r) => r.userId === userId) : null;
  const top = [...items].filter((i) => i.added > 0).sort((a, b) => b.added - a.added || (b.avg || 0) - (a.avg || 0)).slice(0, 3);
  return {
    items,
    summary: {
      suggestions: items.length, addedTotal, level, nextLevelAt: LEVELS[level] || null,
      monthTitle: monthRank ? { month: mt.key, rank: monthRank.rank } : null,
      avgRating: ratingCount >= MIN_RATINGS_FOR_SCORE ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
      top: top.map((t) => ({ kind: t.kind, tmdbId: t.tmdbId, title: t.title, posterPath: t.posterPath, added: t.added, avg: t.avg })),
    },
  };
}

function mountCommunitySuggest(app, { requireAuth, asyncHandler }) {
  const guard = (fn) =>
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        res.json(await fn(req));
      } catch (e) {
        if (e && e.code === "42P01") return res.status(503).json({ error: "Suggestions aren't set up yet." });
        if (e && e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    });

  app.post("/community/suggest", requireAuth, guard(async (req) => {
    const kind = parseKind(req.body?.kind);
    const tmdbId = parseId(req.body?.tmdbId);
    const title = cleanTitle(req.body?.title);
    if (!title) throw httpError(400, "Missing title");
    const ry = parseInt(req.body?.releaseYear, 10);
    const releaseYear = Number.isInteger(ry) && ry > 1800 && ry < 2200 ? ry : null;
    const client = await getPool().connect();
    try {
      await client.query("begin");
      const today = await client.query("select count(*)::int as n from community_suggesters where user_id = $1 and created_at > now() - interval '1 day'", [req.userId]);
      if (today.rows[0].n >= DAILY_LIMIT) throw httpError(429, "You can suggest up to 10 titles a day.");
      const ins = await client.query(
        `insert into community_suggestions (kind, tmdb_id, title, poster_path, release_year) values ($1, $2, $3, $4, $5)
           on conflict (kind, tmdb_id) do nothing returning id`,
        [kind, tmdbId, title, cleanPoster(req.body?.posterPath), releaseYear]
      );
      const id = ins.rows[0] ? Number(ins.rows[0].id)
        : Number((await client.query("select id from community_suggestions where kind = $1 and tmdb_id = $2", [kind, tmdbId])).rows[0].id);
      const mine = await client.query("insert into community_suggesters (suggestion_id, user_id) values ($1, $2) on conflict do nothing returning user_id", [id, req.userId]);
      if (mine.rows.length > 0 && ins.rows.length === 0) {
        await client.query("update community_suggestions set suggest_count = suggest_count + 1, last_suggested_at = now() where id = $1", [id]);
      }
      await client.query("commit");
      return { ok: true, suggestionId: id, already: mine.rows.length === 0 };
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }));

  app.delete("/community/suggest/:kind/:tmdbId", requireAuth, guard(async (req) => {
    const kind = parseKind(req.params.kind);
    const tmdbId = parseId(req.params.tmdbId);
    const client = await getPool().connect();
    try {
      await client.query("begin");
      const s = await client.query("select id from community_suggestions where kind = $1 and tmdb_id = $2 for update", [kind, tmdbId]);
      if (s.rows.length > 0) {
        const id = Number(s.rows[0].id);
        const del = await client.query("delete from community_suggesters where suggestion_id = $1 and user_id = $2", [id, req.userId]);
        if (del.rowCount > 0) {
          const left = await client.query("update community_suggestions set suggest_count = greatest(suggest_count - 1, 0) where id = $1 returning suggest_count", [id]);
          if (left.rows[0].suggest_count === 0) await client.query("delete from community_suggestions where id = $1", [id]);
        }
      }
      await client.query("commit");
      return { ok: true };
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }));

  // How many more titles this person can suggest right now (same rolling 24 hours as POST /community/suggest).
  app.get("/community/limit", requireAuth, guard(async (req) => {
    const { rows } = await getPool().query("select count(*)::int as n from community_suggesters where user_id = $1 and created_at > now() - interval '1 day'", [req.userId]);
    return { limit: DAILY_LIMIT, left: Math.max(0, DAILY_LIMIT - rows[0].n) };
  }));

  // Which of these titles has this person already suggested? (the bulk picker greys those out)
  app.post("/community/suggested-many", requireAuth, guard(async (req) => {
    const kind = parseKind(req.body?.kind);
    const ids = (Array.isArray(req.body?.tmdbIds) ? req.body.tmdbIds : []).slice(0, 100).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
    if (!ids.length) return { suggested: [] };
    const { rows } = await getPool().query(
      `select s.tmdb_id from community_suggesters c join community_suggestions s on s.id = c.suggestion_id
        where c.user_id = $1 and s.kind = $2 and s.tmdb_id = any($3::int[])`,
      [req.userId, kind, ids]
    );
    return { suggested: rows.map((r) => r.tmdb_id) };
  }));

  app.get("/community/suggested", requireAuth, guard(async (req) => {
    const kind = parseKind(req.query.kind);
    const tmdbId = parseId(req.query.tmdbId);
    const { rows } = await getPool().query(
      `select 1 from community_suggesters c join community_suggestions s on s.id = c.suggestion_id
        where c.user_id = $1 and s.kind = $2 and s.tmdb_id = $3`,
      [req.userId, kind, tmdbId]
    );
    return { suggested: rows.length > 0 };
  }));

  app.get("/community/picks", requireAuth, guard(async (req) => {
    const kind = parseKind(req.query.kind);
    const pool = getPool();
    const { weekStart, daysLeft } = nextMonday();
    const fresh = `s.last_suggested_at > now() - interval '${WINDOW_DAYS} days'`;
    const batch = await pool.query("select suggestion_ids from community_pick_batches where user_id = $1 and kind = $2 and week_start = $3", [req.userId, kind, weekStart]);
    let ids;
    let total;
    if (batch.rows.length > 0) {
      ids = batch.rows[0].suggestion_ids.map(Number);
      total = ids.length;
    } else {
      const cand = await pool.query(
        `select ${LIST_COLUMNS} from ${LIST_FROM}
          where s.kind = $2 and ${fresh} and ${NOT_MINE} and coalesce(r.dismissed, false) = false and r.rating is null
          order by (s.suggest_count + random() * 2) desc limit ${PICKS * 3}`,
        [req.userId, kind]
      );
      const open = cand.rows.filter((r) => !r.in_list && !r.added).slice(0, PICKS);
      ids = open.map((r) => Number(r.id));
      total = ids.length;
      if (ids.length >= MIN_FOR_BATCH) {
        await pool.query("insert into community_pick_batches (user_id, kind, week_start, suggestion_ids) values ($1, $2, $3, $4::bigint[]) on conflict do nothing", [req.userId, kind, weekStart, ids]);
      }
    }
    if (ids.length === 0) return { items: [], left: 0, total, refreshInDays: daysLeft };
    const { rows } = await pool.query(
      `select ${LIST_COLUMNS} from ${LIST_FROM}
        where s.id = any($2::bigint[]) and coalesce(r.dismissed, false) = false and coalesce(r.added, false) = false and r.rating is null`,
      [req.userId, ids]
    );
    const byId = new Map(rows.filter((r) => !r.in_list).map((r) => [Number(r.id), shape(r)]));
    const items = ids.map((id) => byId.get(id)).filter(Boolean);
    return { items, left: items.length, total, refreshInDays: daysLeft };
  }));

  app.get("/community/browse", requireAuth, guard(async (req) => {
    const kind = parseKind(req.query.kind);
    const filter = req.query.filter === "new" ? "new" : "popular";
    const offset = Math.max(0, Math.min(parseInt(req.query.offset, 10) || 0, 1000));
    // "no" = only titles that are not on my list, "yes" = only the ones that are, anything else = all.
    const mine = req.query.mine === "no" || req.query.mine === "yes" ? req.query.mine : "all";
    const mineSql = mine === "all" ? "" : `and ${mine === "yes" ? "" : "not "}(${LIST_COLUMNS_IN_LIST})`;
    const order = filter === "new" ? "s.first_suggested_at desc" : "s.suggest_count desc, s.last_suggested_at desc";
    const { rows } = await getPool().query(
      `select ${LIST_COLUMNS} from ${LIST_FROM}
        where s.kind = $2 and s.last_suggested_at > now() - interval '${WINDOW_DAYS} days' and ${NOT_MINE}
          and coalesce(r.dismissed, false) = false and r.rating is null ${mineSql}
        order by ${order}, s.id desc limit ${BROWSE_PAGE + 1} offset ${offset}`,
      [req.userId, kind]
    );
    return { items: rows.slice(0, BROWSE_PAGE).map(shape), hasMore: rows.length > BROWSE_PAGE };
  }));

  const respond = async (userId, suggestionId, set) => {
    const { rows } = await getPool().query("select id, title, kind, tmdb_id from community_suggestions where id = $1", [suggestionId]);
    if (rows.length === 0) throw httpError(404, "Not found");
    const own = await getPool().query("select 1 from community_suggesters where suggestion_id = $1 and user_id = $2", [suggestionId, userId]);
    return { s: rows[0], mine: own.rows.length > 0 };
  };

  app.post("/community/:id/dismiss", requireAuth, guard(async (req) => {
    const id = parseId(req.params.id);
    const { mine } = await respond(req.userId, id);
    if (mine) throw httpError(400, "That's your own suggestion");
    await getPool().query(
      `insert into community_responses (suggestion_id, user_id, dismissed) values ($1, $2, true)
         on conflict (suggestion_id, user_id) do update set dismissed = true, updated_at = now()`,
      [id, req.userId]
    );
    return { ok: true };
  }));

  app.delete("/community/:id/dismiss", requireAuth, guard(async (req) => {
    const id = parseId(req.params.id);
    await getPool().query("update community_responses set dismissed = false, updated_at = now() where suggestion_id = $1 and user_id = $2", [id, req.userId]);
    return { ok: true };
  }));

  app.post("/community/:id/added", requireAuth, guard(async (req) => {
    const id = parseId(req.params.id);
    const { s, mine } = await respond(req.userId, id);
    if (mine) return { ok: true };
    const prev = await getPool().query("select added from community_responses where suggestion_id = $1 and user_id = $2", [id, req.userId]);
    const wasAdded = prev.rows[0]?.added === true;
    await getPool().query(
      `insert into community_responses (suggestion_id, user_id, added, dismissed, added_at) values ($1, $2, true, false, now())
         on conflict (suggestion_id, user_id) do update set added = true, dismissed = false, updated_at = now(),
           added_at = case when community_responses.added then community_responses.added_at else now() end`,
      [id, req.userId]
    );
    if (!wasAdded) {
      const st = (await statsFor([id])).get(id);
      if (st && MILESTONES.includes(st.added)) {
        await notify(await suggesterIds(id), {
          type: "community_added",
          title: `${st.added} people added “${s.title}” to planned`,
          body: "Your suggestion",
          data: { kind: s.kind, tmdbId: s.tmdb_id, suggestionId: id, label: s.title, count: st.added },
        });
      }
    }
    return { ok: true };
  }));

  app.post("/community/:id/rate", requireAuth, guard(async (req) => {
    const id = parseId(req.params.id);
    const rating = parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw httpError(400, "Rating must be 1 to 5");
    const { s, mine } = await respond(req.userId, id);
    if (mine) throw httpError(400, "You can't rate your own suggestion");
    if (!(await onMyList(req.userId, s.kind, s.tmdb_id))) throw httpError(403, "Add it to your list first");
    const prev = await getPool().query("select rating from community_responses where suggestion_id = $1 and user_id = $2", [id, req.userId]);
    const first = !prev.rows[0]?.rating;
    await getPool().query(
      `insert into community_responses (suggestion_id, user_id, rating) values ($1, $2, $3)
         on conflict (suggestion_id, user_id) do update set rating = excluded.rating, updated_at = now()`,
      [id, req.userId, rating]
    );
    if (first) {
      await notify(await suggesterIds(id), {
        type: "community_rating",
        title: `New rating on “${s.title}”: ${rating}`,
        body: "Only you can see this",
        data: { kind: s.kind, tmdbId: s.tmdb_id, suggestionId: id, label: s.title, rating },
      });
    }
    return { ok: true, rating };
  }));

  app.get("/community/mine", requireAuth, guard(async (req) => summaryFor(req.userId)));

  app.get("/community/profile/:userId", requireAuth, guard(async (req) => {
    const target = String(req.params.userId || "").toLowerCase();
    if (!UUID.test(target)) throw httpError(404, "Profile not found");
    if (target !== req.userId) {
      const { readVisibleUser } = require("./follows");
      await readVisibleUser(req.userId, target); // 404 when private or blocked
    }
    const { summary } = await summaryFor(target);
    if (summary.suggestions === 0) return { summary: null };
    return { summary };
  }));
}

module.exports = { mountCommunitySuggest };
