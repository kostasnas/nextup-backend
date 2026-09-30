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

module.exports = { getFriendsActivityFeed };
