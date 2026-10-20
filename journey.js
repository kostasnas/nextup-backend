// journey.js
// "Your first season": use Scenera on 5 different days within your first 7 and collect a
// badge for each one (S01E01 Pilot … S01E05 Season Finale). The fifth unlocks a reward
// (7 days of Scenera Pro, granted through RevenueCat).
//
// Nothing about the badges is stored: the days of use are derived from what the person
// actually did (episodes marked, shows added, movies marked, comments posted), counted in
// their own time zone (user_metadata.acquisition.tz, else UTC). The only things written
// are the in-app notification for each badge (also what stops it being sent twice) and
// user_metadata.season1_reward_at once the reward was granted.
const { getPool } = require("./db");

const EPISODES = 5;
const WINDOW_DAYS = 7;
const REWARD_ENTITLEMENT = "scenera_pro";
const BADGES = [
  { ep: 1, key: "pilot", title: "Pilot", body: "S01E01. Your first episode is in the books." },
  { ep: 2, key: "to_be_continued", title: "To Be Continued", body: "S01E02. You came back. Two down, three to go." },
  { ep: 3, key: "plot_twist", title: "Plot Twist", body: "S01E03. You're a regular now. Two episodes left." },
  { ep: 4, key: "binge_mode", title: "Binge Mode", body: "S01E04. Binge mode is on. One episode to go." },
  { ep: 5, key: "season_finale", title: "Season Finale", body: "S01E05. You finished your first season. Standing ovation." },
];

async function hasTable(name) {
  const { rows } = await getPool().query("select to_regclass($1) as t", [`public.${name}`]);
  return !!rows[0]?.t;
}

// Days (YYYY-MM-DD, the person's local days) on which they did something, within their
// first WINDOW_DAYS days, plus the window itself.
async function readActivity(userId) {
  const withComms = await hasTable("comms_write_log");
  const { rows } = await getPool().query(
    `with u as (
       select id, created_at,
              coalesce((select name from pg_timezone_names where name = raw_user_meta_data->'acquisition'->>'tz' limit 1), 'UTC') as tz,
              raw_user_meta_data->>'season1_reward_at' as reward_at
         from auth.users where id = $1
     ), s as (
       select u.*, (u.created_at at time zone u.tz)::date as start_day,
              (now() at time zone u.tz)::date as today
         from u
     ), acts as (
       select watched_at as ts from watched_episodes where user_id = $1
       union all select created_at from user_watchlist where user_id = $1
       union all select watched_at from user_movie_watchlist where user_id = $1 and watched_at is not null
       union all select updated_at from user_movie_watchlist where user_id = $1
       union all select created_at from episode_comments where user_id = $1
       ${withComms ? "union all select created_at from comms_write_log where user_id = $1 and kind in ('comment','reply')" : ""}
     )
     select s.start_day::text as start_day, s.today::text as today, s.tz, s.reward_at,
            (select coalesce(array_agg(distinct d order by d), '{}')
               from (select (a.ts at time zone s.tz)::date::text as d from acts a where a.ts is not null) x
              where x.d between s.start_day::text and (s.start_day + ${WINDOW_DAYS - 1})::text) as days
       from s`,
    [userId]
  );
  return rows[0] || null;
}

const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

async function getSeason(userId) {
  const r = await readActivity(userId);
  if (!r) return null;
  const days = r.days || [];
  const earned = Math.min(EPISODES, days.length);
  const windowEnd = new Date(Date.parse(r.start_day + "T00:00:00Z") + (WINDOW_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const expired = r.today > windowEnd;
  return {
    earned,
    complete: earned >= EPISODES,
    expired,
    eligible: !expired || earned > 0,
    daysLeft: expired ? 0 : dayDiff(r.today, windowEnd) + 1,
    activeToday: days.includes(r.today),
    rewardClaimed: !!r.reward_at,
    badges: BADGES.map((b) => ({ ep: b.ep, key: b.key, title: b.title, earned: b.ep <= earned, earnedOn: days[b.ep - 1] || null })),
  };
}

// One in-app notification per badge, never twice (also when two requests race).
async function ensureNotifications(userId, earned) {
  if (earned < 1) return;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`journey:${userId}`]);
    const { rows } = await client.query("select (data->>'ep')::int as ep from notifications where user_id = $1 and type = 'badge'", [userId]);
    const have = new Set(rows.map((x) => x.ep));
    for (const b of BADGES) {
      if (b.ep > earned || have.has(b.ep)) continue;
      await client.query(
        "insert into notifications (user_id, type, title, body, data) values ($1, 'badge', $2, $3, $4)",
        [userId, `New badge: ${b.title}`, b.body, JSON.stringify({ ep: b.ep, key: b.key })]
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

async function grantProWeek(userId) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) { const e = new Error("Reward isn't available right now."); e.status = 503; throw e; }
  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}/entitlements/${REWARD_ENTITLEMENT}/promotional`,
    { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ duration: "weekly" }) }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("RevenueCat promotional grant failed:", res.status, text.slice(0, 300));
    const e = new Error("Couldn't add your reward right now. Try again later."); e.status = 502; throw e;
  }
}

function mountJourney(app, { requireAuth, asyncHandler }) {
  app.get("/journey/season", requireAuth, asyncHandler(async (req, res) => {
    const season = await getSeason(req.userId);
    if (!season) return res.json({ eligible: false });
    if (season.eligible) {
      try { await ensureNotifications(req.userId, season.earned); } catch (e) { console.error("badge notifications failed:", e.message); }
    }
    res.json(season);
  }));

  // Claim the Season Finale reward (7 days of Scenera Pro). Once per account.
  app.post("/journey/season/claim", requireAuth, asyncHandler(async (req, res) => {
    const season = await getSeason(req.userId);
    if (!season?.complete) return res.status(400).json({ error: "Finish your first season first." });
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`journey-claim:${req.userId}`]);
      const { rows } = await client.query("select raw_user_meta_data->>'season1_reward_at' as at from auth.users where id = $1", [req.userId]);
      if (rows[0]?.at) { await client.query("rollback"); return res.json({ ok: true, alreadyClaimed: true }); }
      await grantProWeek(req.userId);
      await client.query(
        `update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('season1_reward_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) where id = $1`,
        [req.userId]
      );
      await client.query("commit");
      res.json({ ok: true, days: 7 });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }));
}

module.exports = { mountJourney, getSeason, BADGES };
