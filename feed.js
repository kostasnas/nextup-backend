// feed.js
// Friends Activity Feed — v1, "what have my friends been watching".
// Built as a read-only query over data that already exists
// (watched_episodes for shows, user_movie_watchlist for movies)
// rather than a new events/log table — nothing here writes anything,
// it's a fan-in read across a user's already-accepted friends.
//
// Kept deliberately simple for v1: two queries (episode watches,
// movie watches — the latter carries the rating too, if the friend
// gave one) merged and sorted by time in JS, capped at `limit`. Show
// ratings and "marked favorite" aren't included yet — a proper
// events table is the natural next step if this needs to grow past
// "recent watches," but that's premature for a first version.

const { getPool, getUserDisplayInfo } = require("./db");
const { listFriends } = require("./friends");

async function getFriendIds(supabase, userId) {
  const { data, error } = await supabase
    .from("friend_connections")
    .select("requester_id, recipient_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);
  if (error) throw error;
  return (data || []).map((row) => (row.requester_id === userId ? row.recipient_id : row.requester_id));
}

async function getFriendsActivityFeed(supabase, userId, limit = 30) {
  const friendIds = await getFriendIds(supabase, userId);
  if (friendIds.length === 0) return [];

  const pool = getPool();

  const [episodeRows, movieRows] = await Promise.all([
    pool.query(
      `select we.user_id, we.watched_at, s.tmdb_id as show_tmdb_id, s.title as show_title, s.poster_path,
              e.season_number, e.episode_number
       from watched_episodes we
       join episodes e on e.id = we.episode_id
       join shows s on s.id = e.show_id
       where we.user_id = any($1::uuid[])
       order by we.watched_at desc
       limit $2`,
      [friendIds, limit]
    ),
    pool.query(
      `select umw.user_id, umw.watched_at, umw.rating, m.tmdb_id as movie_tmdb_id, m.title as movie_title, m.poster_path
       from user_movie_watchlist umw
       join movies m on m.id = umw.movie_id
       where umw.user_id = any($1::uuid[]) and umw.status = 'watched' and umw.watched_at is not null
       order by umw.watched_at desc
       limit $2`,
      [friendIds, limit]
    ),
  ]);

  const events = [
    ...episodeRows.rows.map((r) => ({
      type: "episode_watched",
      userId: r.user_id,
      at: r.watched_at,
      show: { tmdbId: r.show_tmdb_id, title: r.show_title, posterPath: r.poster_path },
      season: r.season_number,
      episode: r.episode_number,
    })),
    ...movieRows.rows.map((r) => ({
      type: "movie_watched",
      userId: r.user_id,
      at: r.watched_at,
      movie: { tmdbId: r.movie_tmdb_id, title: r.movie_title, posterPath: r.poster_path },
      rating: r.rating,
    })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);

  // Resolve display names/avatars once per unique friend, not once
  // per event — a friend with several recent watches shouldn't cost
  // a lookup per row.
  const uniqueUserIds = [...new Set(events.map((e) => e.userId))];
  const userInfoById = {};
  await Promise.all(
    uniqueUserIds.map(async (id) => {
      userInfoById[id] = await getUserDisplayInfo(id);
    })
  );

  return events.map((e) => ({
    ...e,
    user: {
      name: userInfoById[e.userId]?.display_name || userInfoById[e.userId]?.email || "Someone",
      avatarUrl: userInfoById[e.userId]?.avatar_url || null,
    },
  }));
}

// v2: grouped by friend instead of one flat chronological list — a
// flat feed doesn't scale past a handful of friends (Kostas flagged
// this with 100 friends in mind), so this returns one row per friend
// instead, sorted by their most recent watch, and the client drills
// into a friend's own shows (getFriendWatching, in friends.js) rather
// than every friend's episodes being interleaved together.
async function getFriendsSummary(supabase, userId) {
  const { friends } = await listFriends(supabase, userId);
  if (friends.length === 0) return [];

  const friendIds = friends.map((f) => f.userId);
  const pool = getPool();

  const [episodeRows, movieRows] = await Promise.all([
    pool.query(
      `select user_id, max(watched_at) as last_at
       from watched_episodes
       where user_id = any($1::uuid[])
       group by user_id`,
      [friendIds]
    ),
    pool.query(
      `select user_id, max(watched_at) as last_at
       from user_movie_watchlist
       where user_id = any($1::uuid[]) and status = 'watched' and watched_at is not null
       group by user_id`,
      [friendIds]
    ),
  ]);

  const lastActivityByUser = {};
  for (const r of [...episodeRows.rows, ...movieRows.rows]) {
    const prev = lastActivityByUser[r.user_id];
    if (!prev || new Date(r.last_at) > new Date(prev)) lastActivityByUser[r.user_id] = r.last_at;
  }

  return friends
    .map((f) => ({ ...f, lastActivityAt: lastActivityByUser[f.userId] || null }))
    .sort((a, b) => {
      if (!a.lastActivityAt && !b.lastActivityAt) return 0;
      if (!a.lastActivityAt) return 1;
      if (!b.lastActivityAt) return -1;
      return new Date(b.lastActivityAt) - new Date(a.lastActivityAt);
    });
}

module.exports = { getFriendsActivityFeed, getFriendsSummary };
