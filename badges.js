// badges.js
// The Badges page: 28 badges in 6 categories, each with a level (1-4 stars = bronze / silver / gold /
// platinum glow in the app). Nothing about a badge is stored: whether it is earned is worked out from
// what the person has actually done, every time (same idea as journey.js "first season").
//
// What counts:
//  - Volume and "first time" badges come from the person's existing data, so people who have been here a
//    while get what they already earned (episodes, finished shows/movies, friends, comments, reactions,
//    imports, first show, taste).
//  - Streaks count days of activity from BADGES_START on (we don't trust historic dates, e.g. a
//    TV Time import carries years of old dates), and "Premiere Night" (share a card) from the first
//    share after the app reports it (POST /badges/event).
//  - A day counts when the person did anything: marked an episode or movie, added a show, wrote a comment.
//
// Notifications: the first time the badges are read for someone, what they already have is recorded
// silently (no flood). After that, each newly earned badge makes one in-app notification (type 'badge',
// data.kind = 'achievement', data.key = the badge key; the app shows it in the person's language).
// "Seen" badges are kept in auth metadata (badges_seen).
const { getPool } = require("./db");

const BADGES_START = process.env.BADGES_START || "2026-10-21T00:00:00Z";

// metric -> where the number comes from (see readMetrics).
const DEFS = [
  // DISCOVERY - first time you...
  { key: "opening_credits", cat: "discovery", stars: 1, metric: "showsAdded", target: 1, title: "Opening Credits", desc: "Add your first show" },
  { key: "rewind", cat: "discovery", stars: 1, metric: "imports", target: 1, title: "Rewind", desc: "Import your history" },
  { key: "co_star", cat: "discovery", stars: 1, metric: "friends", target: 1, title: "Co-Star", desc: "Add a friend" },
  { key: "critic", cat: "discovery", stars: 1, metric: "comments", target: 1, title: "Critic", desc: "Write a comment" },
  { key: "reaction_shot", cat: "discovery", stars: 1, metric: "reactions", target: 1, title: "Reaction Shot", desc: "React to an episode" },
  { key: "premiere_night", cat: "discovery", stars: 1, metric: "shared", target: 1, title: "Premiere Night", desc: "Share a card" },
  // EPISODES
  { key: "getting_hooked", cat: "episodes", stars: 1, metric: "episodes", target: 100, title: "Getting Hooked", desc: "100 episodes" },
  { key: "regular", cat: "episodes", stars: 2, metric: "episodes", target: 500, title: "Regular", desc: "500 episodes" },
  { key: "binge_pro", cat: "episodes", stars: 3, metric: "episodes", target: 1000, title: "Binge Pro", desc: "1,000 episodes" },
  { key: "couch_legend", cat: "episodes", stars: 4, metric: "episodes", target: 5000, title: "Couch Legend", desc: "5,000 episodes" },
  // FINISHED
  { key: "closing_credits", cat: "finished", stars: 1, metric: "showsCompleted", target: 10, title: "Closing Credits", desc: "10 shows completed" },
  { key: "season_finale", cat: "finished", stars: 2, metric: "showsCompleted", target: 50, title: "Season Finale", desc: "50 shows completed" },
  { key: "series_finale", cat: "finished", stars: 3, metric: "showsCompleted", target: 100, title: "Series Finale", desc: "100 shows completed" },
  { key: "cinephile", cat: "finished", stars: 1, metric: "movies", target: 10, title: "Cinephile", desc: "10 movies" },
  { key: "film_buff", cat: "finished", stars: 2, metric: "movies", target: 50, title: "Film Buff", desc: "50 movies" },
  { key: "cinema_icon", cat: "finished", stars: 3, metric: "movies", target: 100, title: "Cinema Icon", desc: "100 movies" },
  // STREAK - days in a row
  { key: "one_week_in", cat: "streak", stars: 1, metric: "streak", target: 7, title: "One Week In", desc: "7 days in a row" },
  { key: "monthly_premiere", cat: "streak", stars: 2, metric: "streak", target: 30, title: "Monthly Premiere", desc: "30 days in a row" },
  { key: "century", cat: "streak", stars: 3, metric: "streak", target: 100, title: "Century", desc: "100 days in a row" },
  { key: "full_year", cat: "streak", stars: 4, metric: "streak", target: 365, title: "Full Year", desc: "365 days in a row" },
  // TASTE
  { key: "anime_fan", cat: "taste", stars: 1, metric: "anime", target: 10, title: "Anime Fan", desc: "10 anime" },
  { key: "kdrama_fan", cat: "taste", stars: 1, metric: "kdrama", target: 10, title: "K-Drama Fan", desc: "10 K-dramas" },
  { key: "hopeless_romantic", cat: "taste", stars: 1, metric: "romance", target: 10, title: "Hopeless Romantic", desc: "10 romance shows" },
  { key: "genre_hopper", cat: "taste", stars: 1, metric: "genres", target: 5, title: "Genre Hopper", desc: "5 different genres" },
  // SOCIAL
  { key: "squad", cat: "social", stars: 1, metric: "friends", target: 5, title: "Squad", desc: "5 friends" },
  { key: "ensemble_cast", cat: "social", stars: 2, metric: "friends", target: 20, title: "Ensemble Cast", desc: "20 friends" },
  { key: "talkative", cat: "social", stars: 1, metric: "comments", target: 10, title: "Talkative", desc: "10 comments" },
  { key: "fan_club", cat: "social", stars: 3, metric: "comments", target: 50, title: "Fan Club", desc: "50 comments" },
];
const CATEGORIES = ["discovery", "episodes", "finished", "streak", "taste", "social"];

async function hasTable(name) {
  const { rows } = await getPool().query("select to_regclass($1) as t", [`public.${name}`]);
  return !!rows[0]?.t;
}

// Longest run of consecutive days in a sorted list of 'YYYY-MM-DD' strings.
function longestRun(days) {
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    const t = Date.parse(d + "T00:00:00Z");
    run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  }
  return best;
}

// Taste counts: shows the person has actually watched from (an episode ticked) or finished.
// origin_country needs the shows.origin_country column (migrations/shows_origin_country.sql + backfill);
// until it exists anime and K-dramas simply count as 0 instead of failing.
async function readTaste(userId) {
  const pool = getPool();
  const sql = (cols) => `select ${cols} from shows s where s.id in (
      select e.show_id from watched_episodes we join episodes e on e.id = we.episode_id where we.user_id = $1
      union select show_id from user_watchlist where user_id = $1 and status = 'completed')`;
  let rows;
  let hasOrigin = true;
  try {
    ({ rows } = await pool.query(sql("s.genres, s.origin_country"), [userId]));
  } catch (e) {
    if (e.code !== "42703") throw e;
    hasOrigin = false;
    try { ({ rows } = await pool.query(sql("s.genres"), [userId])); } catch (e2) { if (e2.code !== "42703") throw e2; rows = []; }
  }
  const out = { anime: 0, kdrama: 0, romance: 0, genres: 0, needsOrigin: !hasOrigin };
  const all = new Set();
  for (const r of rows) {
    const g = r.genres || [];
    const c = r.origin_country || [];
    g.forEach((x) => all.add(x));
    if (g.includes("Romance")) out.romance++;
    if (c.includes("JP") && g.includes("Animation")) out.anime++;
    if (c.includes("KR") && g.includes("Drama") && !g.includes("Animation") && !g.includes("Reality") && !g.includes("Talk")) out.kdrama++;
  }
  out.genres = all.size;
  return out;
}

async function readMetrics(userId) {
  const pool = getPool();
  const withComms = await hasTable("comms_write_log");
  const one = async (sql, params = [userId]) => (await pool.query(sql, params)).rows[0] || {};
  const [counts, friends, comments, imports, user, days, taste] = await Promise.all([
    one(`select (select count(*)::int from watched_episodes where user_id = $1) as episodes,
                (select count(*)::int from watched_episodes where user_id = $1 and reaction is not null) as reactions,
                (select count(*)::int from user_watchlist where user_id = $1) as shows_added,
                (select count(*)::int from user_watchlist where user_id = $1 and status = 'completed') as shows_completed,
                (select count(*)::int from user_movie_watchlist where user_id = $1 and status = 'watched') as movies`),
    one("select count(*)::int as n from friend_connections where status = 'accepted' and (requester_id = $1 or recipient_id = $1)"),
    one(`select (select count(*)::int from episode_comments where user_id = $1)
              ${withComms ? "+ (select count(*)::int from comms_write_log where user_id = $1 and kind in ('comment','reply'))" : ""} as n`),
    one("select count(*)::int as n from import_jobs where user_id = $1 and status = 'completed' and coalesce(matched_records, 0) > 0"),
    one(`select raw_user_meta_data->>'badge_shared_at' as shared_at, raw_user_meta_data->'badges_seen' as seen,
                coalesce((select name from pg_timezone_names where name = raw_user_meta_data->'acquisition'->>'tz' limit 1), 'UTC') as tz
           from auth.users where id = $1`),
    // Days (the person's local days) with any activity since BADGES_START.
    pool.query(
      `with u as (select coalesce((select name from pg_timezone_names where name = raw_user_meta_data->'acquisition'->>'tz' limit 1), 'UTC') as tz
                    from auth.users where id = $1),
            acts as (
              select watched_at as ts from watched_episodes where user_id = $1
              union all select created_at from user_watchlist where user_id = $1
              union all select watched_at from user_movie_watchlist where user_id = $1 and watched_at is not null
              union all select updated_at from user_movie_watchlist where user_id = $1
              union all select created_at from episode_comments where user_id = $1
              ${withComms ? "union all select created_at from comms_write_log where user_id = $1 and kind in ('comment','reply')" : ""}
            )
       select distinct (a.ts at time zone u.tz)::date::text as d
         from acts a, u where a.ts >= $2::timestamptz order by d`,
      [userId, BADGES_START]
    ),
    readTaste(userId),
  ]);
  return {
    metrics: {
      episodes: counts.episodes || 0,
      reactions: counts.reactions || 0,
      showsAdded: counts.shows_added || 0,
      showsCompleted: counts.shows_completed || 0,
      movies: counts.movies || 0,
      friends: friends.n || 0,
      comments: comments.n || 0,
      imports: imports.n || 0,
      shared: user.shared_at ? 1 : 0,
      streak: longestRun(days.rows.map((r) => r.d)),
      anime: taste.anime, kdrama: taste.kdrama, romance: taste.romance, genres: taste.genres,
    },
    seen: Array.isArray(user.seen) ? user.seen : null,
    needsOrigin: taste.needsOrigin,
  };
}

function evaluate(metrics) {
  return DEFS.map((d) => {
    const value = metrics[d.metric] || 0;
    return { key: d.key, cat: d.cat, stars: d.stars, target: d.target, value: Math.min(value, d.target), earned: value >= d.target };
  });
}

// First read for a person = record what they already have, quietly. After that, one notification
// per newly earned badge. Serialised per person so two requests can't send it twice.
async function syncNotifications(userId, earnedKeys, seenBefore) {
  if (seenBefore && earnedKeys.every((k) => seenBefore.includes(k))) return;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`badges:${userId}`]);
    const { rows } = await client.query("select raw_user_meta_data->'badges_seen' as seen from auth.users where id = $1", [userId]);
    const seen = Array.isArray(rows[0]?.seen) ? rows[0].seen : null;
    const fresh = seen ? earnedKeys.filter((k) => !seen.includes(k)) : [];
    for (const k of fresh) {
      const d = DEFS.find((x) => x.key === k);
      await client.query(
        "insert into notifications (user_id, type, title, body, data) values ($1, 'badge', $2, $3, $4)",
        [userId, `New badge: ${d.title}`, d.desc, JSON.stringify({ kind: "achievement", key: k, target: d.target })]
      );
    }
    if (!seen || fresh.length) {
      const merged = [...new Set([...(seen || []), ...earnedKeys])];
      await client.query(
        "update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('badges_seen', $2::jsonb) where id = $1",
        [userId, JSON.stringify(merged)]
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getBadges(userId) {
  const { metrics, seen, needsOrigin } = await readMetrics(userId);
  const badges = evaluate(metrics);
  const earnedKeys = badges.filter((b) => b.earned).map((b) => b.key);
  try { await syncNotifications(userId, earnedKeys, seen); } catch (e) { console.error("badge notifications failed:", e.message); }
  return { earned: earnedKeys.length, total: badges.length, categories: CATEGORIES, badges, needsOrigin };
}

function mountBadges(app, { requireAuth, asyncHandler }) {
  app.get("/badges", requireAuth, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getBadges(req.userId));
  }));

  // Things the server can't see on its own. Only "share" (a card was shared) for now.
  app.post("/badges/event", requireAuth, asyncHandler(async (req, res) => {
    if (req.body?.event !== "share") return res.status(400).json({ error: "unknown event" });
    await getPool().query(
      `update auth.users
          set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('badge_shared_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        where id = $1 and raw_user_meta_data->>'badge_shared_at' is null`,
      [req.userId]
    );
    res.json({ ok: true });
  }));
}

module.exports = { mountBadges, getBadges, evaluate, longestRun, DEFS, CATEGORIES };
