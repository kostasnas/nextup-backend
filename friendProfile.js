// friendProfile.js
// A friend's profile page: who they are, their Pioneer ticket, favourite characters and a handful of
// headline numbers (shows completed, episodes, movies, friends, time in front of the TV, last 7 days).
//
// Rules:
//  - Only an ACCEPTED friend can see it, and only through their own connection (same checks as
//    /friends/:id/favorites and /friends/:id/watching).
//  - Never returned: email, private notes, the person's lists.
//  - Privacy toggle "Hide my stats from friends": stored in the person's auth metadata
//    (hide_stats_from_friends), so it needs no migration. Off by default. When it's on, the numbers
//    are left out ({ statsHidden: true }); name, @username, Pioneer ticket and cast still show.
const { getPool } = require("./db");

const DEFAULT_EPISODE_MINUTES = 42; // same fallback as /stats/summary

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function resolveFriendId(supabase, connectionId, userId) {
  const { data: row, error } = await supabase.from("friend_connections").select("*").eq("id", connectionId).single();
  if (error || !row || row.status !== "accepted") throw httpError(404, "Not an accepted friend connection");
  if (row.requester_id !== userId && row.recipient_id !== userId) throw httpError(403, "Not your connection");
  return row.requester_id === userId ? row.recipient_id : row.requester_id;
}

function pioneerTier(number) {
  if (!number || number > 1000) return null;
  return number <= 100 ? "premiere" : number <= 500 ? "matinee" : "early";
}

async function readIdentity(supabase, friendId) {
  const { rows } = await getPool().query(
    `select raw_user_meta_data->>'display_name' as display_name,
            raw_user_meta_data->>'avatar_url' as avatar_url,
            email,
            (raw_user_meta_data->>'pioneer_number')::int as pioneer_number,
            (raw_user_meta_data->>'hide_stats_from_friends') = 'true' as hide_stats,
            created_at
       from auth.users where id = $1`,
    [friendId]
  );
  const u = rows[0];
  if (!u) throw httpError(404, "User not found");
  const { data: prof } = await supabase.from("user_profiles").select("username").eq("user_id", friendId).maybeSingle();
  const number = u.pioneer_number || null;
  const tier = pioneerTier(number);
  return {
    name: u.display_name || (u.email ? u.email.split("@")[0] : "Friend"), // never the full email
    avatarUrl: u.avatar_url || null,
    username: prof?.username || null,
    ticket: tier ? { number, tier, joined: u.created_at } : null,
    hideStats: !!u.hide_stats,
  };
}

async function readCast(supabase, friendId) {
  const { data } = await supabase
    .from("favorite_characters")
    .select("tmdb_person_id, person_name, profile_path, character_name, character_image_url, source_type, source_tmdb_id, source_title")
    .eq("user_id", friendId)
    .order("created_at", { ascending: false })
    .limit(12);
  return data || [];
}

async function readStats(friendId) {
  const pool = getPool();
  const [shows, eps, movies, friends, time, week] = await Promise.all([
    pool.query("select count(*)::int as n from user_watchlist where user_id = $1 and status = 'completed'", [friendId]),
    pool.query("select count(*)::int as n from watched_episodes where user_id = $1", [friendId]),
    pool.query("select count(*)::int as n from user_movie_watchlist where user_id = $1 and status = 'watched'", [friendId]),
    pool.query(
      "select count(*)::int as n from friend_connections where status = 'accepted' and (requester_id = $1 or recipient_id = $1)",
      [friendId]
    ),
    // Same arithmetic as /stats/summary: episode minutes (show runtime, else 42) + watched movie runtimes.
    pool.query(
      `select
         (select coalesce(sum(coalesce(s.avg_episode_runtime, $2)), 0)::float
            from watched_episodes we join episodes e on e.id = we.episode_id join shows s on s.id = e.show_id
           where we.user_id = $1)
       + (select coalesce(sum(coalesce(m.runtime, 0)), 0)::float
            from user_movie_watchlist w left join movies m on m.id = w.movie_id
           where w.user_id = $1 and w.status = 'watched') as minutes`,
      [friendId, DEFAULT_EPISODE_MINUTES]
    ),
    pool.query(
      "select count(*)::int as n from watched_episodes where user_id = $1 and watched_at >= now() - interval '7 days'",
      [friendId]
    ),
  ]);
  return {
    showsCompleted: shows.rows[0].n,
    episodes: eps.rows[0].n,
    movies: movies.rows[0].n,
    friends: friends.rows[0].n,
    hours: Math.round(time.rows[0].minutes / 60),
    last7Days: week.rows[0].n,
  };
}

async function getFriendProfile(supabase, connectionId, userId) {
  const friendId = await resolveFriendId(supabase, connectionId, userId);
  // The numbers are computed at the same time as the identity instead of after it (one round trip less); they are only
  // returned when the person has not chosen to hide them, and only after the accepted-friend check above.
  const [identity, cast, stats] = await Promise.all([readIdentity(supabase, friendId), readCast(supabase, friendId), readStats(friendId)]);
  const profile = {
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    username: identity.username,
    ticket: identity.ticket,
    cast,
    statsHidden: identity.hideStats,
  };
  if (!identity.hideStats) profile.stats = stats;
  return profile;
}

function mountFriendProfile(app, { supabase, requireAuth, asyncHandler }) {
  app.get("/friends/:id/profile", requireAuth, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getFriendProfile(supabase, req.params.id, req.userId));
  }));

  // The person's own privacy setting.
  app.get("/profile/privacy", requireAuth, asyncHandler(async (req, res) => {
    const { rows } = await getPool().query(
      "select (raw_user_meta_data->>'hide_stats_from_friends') = 'true' as hide from auth.users where id = $1",
      [req.userId]
    );
    res.json({ hideStats: !!rows[0]?.hide });
  }));

  app.post("/profile/privacy", requireAuth, asyncHandler(async (req, res) => {
    if (typeof req.body?.hideStats !== "boolean") return res.status(400).json({ error: "hideStats (true/false) is required" });
    await getPool().query(
      `update auth.users
          set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('hide_stats_from_friends', $2::boolean)
        where id = $1`,
      [req.userId, req.body.hideStats]
    );
    res.json({ ok: true, hideStats: req.body.hideStats });
  }));
}

module.exports = { mountFriendProfile, getFriendProfile, pioneerTier };
