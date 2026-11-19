// follows.js
// One-way follows, public profiles, blocks and profile reports.
//
// Rules:
//  - A profile is public only when the person turned on "Public profile" (auth metadata public_profile, off by
//    default; needs a username). Only public profiles can be opened or followed by people who are not friends.
//  - A public profile shows: name, @username, Pioneer ticket and follower/following counts. Favourites and recent
//    watches are only shared with followers the owner approved (see getActivity).
//    Never: email, stats, journey, what they are watching, lists, chats.
//  - Block works both ways: neither person can open, follow or list the other, and any follow between them is removed.
//  - Turning the profile private keeps existing follows but hides the profile (and the lists of that person).
const { getPool, findUserByUsername } = require("./db");
const { sendPushToUser } = require("./pushNotifications");
const { createNotification } = require("./notifications");
const { pioneerTier } = require("./friendProfile");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 100;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function checkId(id) {
  if (!UUID_RE.test(String(id || ""))) throw httpError(404, "Profile not found");
  return String(id).toLowerCase();
}

async function isBlocked(a, b) {
  const { rows } = await getPool().query(
    "select 1 from user_blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) limit 1",
    [a, b]
  );
  return rows.length > 0;
}

async function readUser(userId) {
  const { rows } = await getPool().query(
    `select u.id,
            u.raw_user_meta_data->>'display_name' as display_name,
            u.raw_user_meta_data->>'avatar_url' as avatar_url,
            (u.raw_user_meta_data->>'pioneer_number')::int as pioneer_number,
            (u.raw_user_meta_data->>'public_profile') = 'true' as is_public,
            u.created_at,
            up.username
       from auth.users u
       left join user_profiles up on up.user_id = u.id
      where u.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

function shortName(u) {
  return u.display_name || u.username || "Someone";
}

// The profile of someone else is only visible when it is public and nobody blocked anybody.
async function readVisibleUser(viewerId, targetId) {
  const u = await readUser(targetId);
  if (!u) throw httpError(404, "Profile not found");
  if (targetId === viewerId) return u;
  if (!u.is_public) throw httpError(404, "Profile not found");
  if (await isBlocked(viewerId, targetId)) throw httpError(404, "Profile not found");
  return u;
}

async function getPublicProfile(viewerId, targetId) {
  const u = await readVisibleUser(viewerId, targetId);
  const pool = getPool();
  const [counts, rel, friend, grant] = await Promise.all([
    pool.query(
      `select (select count(*)::int from follows where followed_id = $1) as followers,
              (select count(*)::int from follows where follower_id = $1) as following`,
      [targetId]
    ),
    pool.query(
      `select exists(select 1 from follows where follower_id = $1 and followed_id = $2) as following,
              exists(select 1 from follows where follower_id = $2 and followed_id = $1) as follows_you`,
      [viewerId, targetId]
    ),
    pool.query(
      `select id, status from friend_connections
        where (requester_id = $1 and recipient_id = $2) or (requester_id = $2 and recipient_id = $1) limit 1`,
      [viewerId, targetId]
    ),
    pool.query("select 1 from follow_activity_grants where owner_id = $1 and follower_id = $2", [targetId, viewerId]),
  ]);
  const tier = pioneerTier(u.pioneer_number);
  const conn = friend.rows[0] || null;
  return {
    id: u.id,
    name: shortName(u),
    avatarUrl: u.avatar_url || null,
    username: u.username || null,
    isPublic: !!u.is_public,
    ticket: tier ? { number: u.pioneer_number, tier, joined: u.created_at } : null,
    followers: counts.rows[0].followers,
    following: counts.rows[0].following,
    viewer: {
      isSelf: viewerId === targetId,
      following: rel.rows[0].following,
      followsYou: rel.rows[0].follows_you,
      friendStatus: conn ? conn.status : null, // "accepted" | "pending" | null
      canSeeActivity: grant.rows.length > 0, // the person lets the viewer see their activity
    },
  };
}

async function follow(supabase, viewerId, targetId) {
  if (viewerId === targetId) throw httpError(400, "You cannot follow yourself");
  const u = await readVisibleUser(viewerId, targetId);
  const { rows } = await getPool().query(
    "insert into follows (follower_id, followed_id) values ($1, $2) on conflict do nothing returning follower_id",
    [viewerId, targetId]
  );
  if (rows.length > 0) {
    // Only the first follow notifies, so unfollow/follow cannot be used to spam someone.
    const me = await readUser(viewerId);
    if (me) {
      const payload = {
        title: "New follower",
        body: `${shortName(me)}${me.username ? ` (@${me.username})` : ""} started following you`,
        data: { type: "follow", userId: viewerId },
      };
      createNotification(supabase, u.id, { type: "follow", ...payload }).catch(() => {});
      sendPushToUser(supabase, u.id, payload).catch(() => {});
    }
  }
  return { ok: true, following: true };
}

async function unfollow(viewerId, targetId) {
  await getPool().query("delete from follows where follower_id = $1 and followed_id = $2", [viewerId, targetId]);
  await getPool().query("delete from follow_activity_grants where owner_id = $2 and follower_id = $1", [viewerId, targetId]);
  return { ok: true, following: false };
}

// Followers (kind "followers") or the people someone follows (kind "following").
async function listFollows(viewerId, targetId, kind, offset) {
  if (targetId !== viewerId) await readVisibleUser(viewerId, targetId);
  const mine = targetId === viewerId;
  const [pivot, other] = kind === "followers" ? ["followed_id", "follower_id"] : ["follower_id", "followed_id"];
  const { rows } = await getPool().query(
    `select u.id,
            u.raw_user_meta_data->>'display_name' as display_name,
            u.raw_user_meta_data->>'avatar_url' as avatar_url,
            (u.raw_user_meta_data->>'public_profile') = 'true' as is_public,
            up.username,
            exists(select 1 from follows v where v.follower_id = $2 and v.followed_id = u.id) as viewer_following,
            exists(select 1 from follow_activity_grants g where g.owner_id = $1 and g.follower_id = u.id) as shares_activity
       from follows f
       join auth.users u on u.id = f.${other}
       left join user_profiles up on up.user_id = u.id
      where f.${pivot} = $1
        and not exists (
          select 1 from user_blocks b
           where (b.blocker_id = $2 and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = $2)
        )
        and ($3::boolean or (u.raw_user_meta_data->>'public_profile') = 'true')
      order by f.created_at desc
      limit ${LIST_LIMIT} offset $4`,
    [targetId, viewerId, mine, offset]
  );
  return {
    users: rows.map((r) => ({
      id: r.id,
      name: r.display_name || r.username || "Someone",
      avatarUrl: r.avatar_url || null,
      username: r.username || null,
      isPublic: !!r.is_public,
      viewerFollowing: r.viewer_following,
      sharesActivity: mine && kind === "followers" ? r.shares_activity : undefined,
      isSelf: r.id === viewerId,
    })),
    hasMore: rows.length === LIST_LIMIT,
  };
}

async function block(viewerId, targetId) {
  if (viewerId === targetId) throw httpError(400, "You cannot block yourself");
  const pool = getPool();
  const exists = await readUser(targetId);
  if (!exists) throw httpError(404, "Profile not found");
  await pool.query("insert into user_blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing", [viewerId, targetId]);
  await pool.query(
    "delete from follows where (follower_id = $1 and followed_id = $2) or (follower_id = $2 and followed_id = $1)",
    [viewerId, targetId]
  );
  await pool.query(
    "delete from follow_activity_grants where (owner_id = $1 and follower_id = $2) or (owner_id = $2 and follower_id = $1)",
    [viewerId, targetId]
  );
  return { ok: true, blocked: true };
}

async function unblock(viewerId, targetId) {
  await getPool().query("delete from user_blocks where blocker_id = $1 and blocked_id = $2", [viewerId, targetId]);
  return { ok: true, blocked: false };
}

async function report(viewerId, targetId, reason) {
  if (viewerId === targetId) throw httpError(400, "You cannot report yourself");
  const exists = await readUser(targetId);
  if (!exists) throw httpError(404, "Profile not found");
  const text = String(reason || "").trim().slice(0, 500) || null;
  const pool = getPool();
  // One report per person per profile per day.
  const recent = await pool.query(
    "select 1 from user_reports where reporter_id = $1 and reported_id = $2 and created_at > now() - interval '1 day' limit 1",
    [viewerId, targetId]
  );
  if (recent.rows.length === 0) {
    await pool.query("insert into user_reports (reporter_id, reported_id, reason) values ($1, $2, $3)", [viewerId, targetId, text]);
  }
  return { ok: true };
}

// The owner lets one of their followers see their activity (or takes it back).
async function setActivityShare(ownerId, followerId, share) {
  if (ownerId === followerId) throw httpError(400, "Not allowed");
  const pool = getPool();
  if (share) {
    const f = await pool.query("select 1 from follows where follower_id = $1 and followed_id = $2", [followerId, ownerId]);
    if (f.rows.length === 0) throw httpError(404, "Not a follower");
    await pool.query("insert into follow_activity_grants (owner_id, follower_id) values ($1, $2) on conflict do nothing", [ownerId, followerId]);
  } else {
    await pool.query("delete from follow_activity_grants where owner_id = $1 and follower_id = $2", [ownerId, followerId]);
  }
  return { ok: true, sharing: !!share };
}

const LIVE_HOURS = 48;

// What a follower sees of someone who allowed it: their favourite shows and movies, plus what they watched in
// the last 48 hours (one row per show, latest episode; and movies). Nothing else from their lists: no ratings,
// counts, notes or comments.
async function getActivity(viewerId, ownerId) {
  if (viewerId !== ownerId) {
    await readVisibleUser(viewerId, ownerId);
    const g = await getPool().query("select 1 from follow_activity_grants where owner_id = $1 and follower_id = $2", [ownerId, viewerId]);
    const f = await getPool().query("select 1 from follows where follower_id = $2 and followed_id = $1", [ownerId, viewerId]);
    if (g.rows.length === 0 || f.rows.length === 0) throw httpError(403, "Activity is not shared");
  }
  const pool = getPool();
  const [favShows, favMovies, recentShows, recentMovies] = await Promise.all([
    pool.query(
      `select s.tmdb_id, s.title, s.poster_path from user_watchlist w join shows s on s.id = w.show_id
        where w.user_id = $1 and w.is_favorite = true order by 2 limit 60`,
      [ownerId]
    ),
    pool.query(
      `select m.tmdb_id, m.title, m.poster_path from user_movie_watchlist w join movies m on m.id = w.movie_id
        where w.user_id = $1 and w.is_favorite = true order by 2 limit 60`,
      [ownerId]
    ),
    pool.query(
      `select distinct on (s.id) we.watched_at, s.tmdb_id, s.title, s.poster_path, e.season_number, e.episode_number
         from watched_episodes we join episodes e on e.id = we.episode_id join shows s on s.id = e.show_id
        where we.user_id = $1 and we.watched_at > now() - interval '${LIVE_HOURS} hours'
        order by s.id, we.watched_at desc`,
      [ownerId]
    ),
    pool.query(
      `select w.watched_at, m.tmdb_id, m.title, m.poster_path from user_movie_watchlist w join movies m on m.id = w.movie_id
        where w.user_id = $1 and w.status = 'watched' and w.watched_at > now() - interval '${LIVE_HOURS} hours'
        order by w.watched_at desc limit 20`,
      [ownerId]
    ),
  ]);
  const map = (r) => ({ tmdbId: r.tmdb_id, title: r.title, posterPath: r.poster_path });
  const byTime = (a, b) => new Date(b.at) - new Date(a.at);
  return {
    shows: {
      recent: recentShows.rows.map((r) => ({ ...map(r), season: r.season_number, episode: r.episode_number, at: r.watched_at })).sort(byTime),
      favorites: favShows.rows.map(map),
    },
    movies: {
      recent: recentMovies.rows.map((r) => ({ ...map(r), at: r.watched_at })).sort(byTime),
      favorites: favMovies.rows.map(map),
    },
  };
}

// "Add follower" by @username. Like the friend lookup, the answer is always the same, so it never reveals
// whether an account exists or has a public profile.
async function followByUsername(supabase, viewerId, username) {
  const clean = String(username || "").trim().replace(/^@/, "");
  if (clean && /^[A-Za-z0-9._-]{1,40}$/.test(clean)) {
    const target = await findUserByUsername(clean);
    if (target && target.id !== viewerId) {
      try { await follow(supabase, viewerId, target.id); } catch (e) { if (!e.status) throw e; }
    }
  }
  return { ok: true };
}

function mountFollows(app, { supabase, requireAuth, asyncHandler }) {
  const guard = (fn) =>
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        res.json(await fn(req));
      } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    });

  app.post("/follow/by-username", requireAuth, guard((req) => followByUsername(supabase, req.userId, req.body?.username)));
  app.get("/users/:id/profile", requireAuth, guard((req) => getPublicProfile(req.userId, checkId(req.params.id))));
  app.post("/users/:id/follow", requireAuth, guard((req) => follow(supabase, req.userId, checkId(req.params.id))));
  app.delete("/users/:id/follow", requireAuth, guard((req) => unfollow(req.userId, checkId(req.params.id))));
  app.get("/users/:id/followers", requireAuth, guard((req) => listFollows(req.userId, checkId(req.params.id), "followers", Math.max(0, parseInt(req.query.offset, 10) || 0))));
  app.get("/users/:id/following", requireAuth, guard((req) => listFollows(req.userId, checkId(req.params.id), "following", Math.max(0, parseInt(req.query.offset, 10) || 0))));
  app.get("/users/:id/activity", requireAuth, guard((req) => getActivity(req.userId, checkId(req.params.id))));
  // Owner (the signed-in person) lets follower :id see their activity (POST) or stops that (DELETE).
  app.post("/users/:id/activity-share", requireAuth, guard((req) => setActivityShare(req.userId, checkId(req.params.id), true)));
  app.delete("/users/:id/activity-share", requireAuth, guard((req) => setActivityShare(req.userId, checkId(req.params.id), false)));
  app.post("/users/:id/block", requireAuth, guard((req) => block(req.userId, checkId(req.params.id))));
  app.delete("/users/:id/block", requireAuth, guard((req) => unblock(req.userId, checkId(req.params.id))));
  app.post("/users/:id/report", requireAuth, guard((req) => report(req.userId, checkId(req.params.id), req.body?.reason)));
}

// For the invite flow: can the invited person follow this inviter (public profile)?
async function isPublicUser(userId) {
  const u = await readUser(userId);
  return !!u?.is_public;
}

module.exports = { mountFollows, follow, isPublicUser, readVisibleUser };
