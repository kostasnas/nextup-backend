// accountExport.js
// "Export my data": everything this account owns, as one JSON document.
//
// Why on the backend: a user-scoped client read is capped by PostgREST at
// 1000 rows per request (a long-time tracker has thousands of watched
// episodes), and some tables (comments, messages, friends) are only reachable
// with the service key. Every section is fetched in pages and guarded on its
// own, so one unexpected table/column problem never loses the whole export —
// the problem is listed under `notes` instead.
//
// Deliberately NOT included: device push tokens, AI usage counters, OAuth
// tokens (e.g. Trakt) and other people's messages/profile data. Messages are
// exported only if this user wrote them.

const PAGE = 1000;

async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// Tries the query with a join first (nice, readable show/episode names) and
// falls back to the plain table if that relationship isn't available.
async function fetchAllWithJoin(supabase, table, joinSelect, apply) {
  try {
    return await fetchAll(() => apply(supabase.from(table).select(joinSelect)));
  } catch (e) {
    return await fetchAll(() => apply(supabase.from(table).select("*")));
  }
}

function episodeRef(ep) {
  if (!ep) return {};
  return {
    show: ep.shows?.title ?? null,
    tmdb_id: ep.shows?.tmdb_id ?? null,
    season: ep.season_number ?? null,
    episode: ep.episode_number ?? null,
    episode_title: ep.title ?? null,
  };
}

async function buildAccountExport(supabase, userId, email) {
  const notes = [];
  const section = async (name, fn, fallback = []) => {
    try {
      return await fn();
    } catch (e) {
      notes.push(`${name}: could not be exported (${e.message || "error"})`);
      return fallback;
    }
  };

  const account = await section("account", async () => {
    const { data } = await supabase.auth.admin.getUserById(userId);
    return { id: userId, email, created_at: data?.user?.created_at || null };
  }, { id: userId, email });

  const profile = await section("profile", async () => {
    const { data } = await supabase.from("user_profiles").select("*").eq("user_id", userId).maybeSingle();
    if (!data) return null;
    const { user_id, ...rest } = data;
    return rest;
  }, null);

  const watchlist = await section("watchlist", async () => {
    const rows = await fetchAllWithJoin(supabase, "user_watchlist", "*, shows(title, tmdb_id)", (q) => q.eq("user_id", userId));
    return rows.map(({ shows, user_id, show_id, ...r }) => ({
      show: shows?.title ?? null,
      tmdb_id: shows?.tmdb_id ?? null,
      status: r.status,
      rating: r.rating ?? null,
      favorite: r.is_favorite ?? null,
      updated_at: r.updated_at ?? null,
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !["status", "rating", "is_favorite", "updated_at"].includes(k))),
    }));
  });

  const watchedEpisodes = await section("watched_episodes", async () => {
    const rows = await fetchAllWithJoin(
      supabase, "watched_episodes",
      "*, episodes(season_number, episode_number, title, shows(title, tmdb_id))",
      (q) => q.eq("user_id", userId)
    );
    return rows.map(({ episodes, user_id, episode_id, ...r }) => ({
      ...episodeRef(episodes),
      reaction: r.reaction ?? null,
      watched_at: r.watched_at ?? null,
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !["reaction", "watched_at"].includes(k))),
    }));
  });

  const rewatches = await section("rewatches", async () => {
    const rows = await fetchAllWithJoin(
      supabase, "episode_rewatches",
      "*, episodes(season_number, episode_number, title, shows(title, tmdb_id))",
      (q) => q.eq("user_id", userId)
    );
    return rows.map(({ episodes, user_id, ...r }) => ({ ...episodeRef(episodes), ...r }));
  });

  const movies = await section("movies", async () => {
    const rows = await fetchAllWithJoin(supabase, "user_movie_watchlist", "*, movies(*)", (q) => q.eq("user_id", userId));
    return rows.map(({ movies: m, user_id, movie_id, ...r }) => ({
      movie: m?.title ?? null,
      tmdb_id: m?.tmdb_id ?? null,
      release_date: m?.release_date ?? null,
      ...r,
    }));
  });

  const comments = await section("comments", async () => {
    const rows = await fetchAllWithJoin(
      supabase, "episode_comments",
      "*, episodes(season_number, episode_number, title, shows(title, tmdb_id))",
      (q) => q.eq("user_id", userId)
    );
    return rows.map(({ episodes, user_id, ...r }) => ({ ...episodeRef(episodes), ...r }));
  });

  const commentLikes = await section("comment_likes", () =>
    fetchAll(() => supabase.from("comment_likes").select("*").eq("user_id", userId))
      .then((rows) => rows.map(({ user_id, ...r }) => r))
  );

  const favoriteCharacters = await section("favorite_characters", () =>
    fetchAll(() => supabase.from("favorite_characters").select("*").eq("user_id", userId))
      .then((rows) => rows.map(({ user_id, ...r }) => r))
  );

  // Friends and the messages this user wrote. Names of the other people are
  // limited to their public Scenera username.
  let connections = [];
  const friends = await section("friends", async () => {
    connections = await fetchAll(() =>
      supabase.from("friend_connections").select("*").or(`requester_id.eq.${userId},recipient_id.eq.${userId}`)
    );
    const otherIds = [...new Set(connections.map((c) => (c.requester_id === userId ? c.recipient_id : c.requester_id)))];
    const names = {};
    if (otherIds.length) {
      const { data } = await supabase.from("user_profiles").select("user_id, username").in("user_id", otherIds);
      for (const p of data || []) names[p.user_id] = p.username;
    }
    return connections.map((c) => {
      const other = c.requester_id === userId ? c.recipient_id : c.requester_id;
      return {
        username: names[other] || null,
        status: c.status,
        you_sent_the_request: c.requester_id === userId,
        created_at: c.created_at ?? null,
      };
    });
  });

  const messagesSent = await section("messages", async () => {
    const rows = await fetchAll(() => supabase.from("messages").select("*").eq("sender_id", userId));
    const connById = Object.fromEntries(connections.map((c) => [c.id, c]));
    const otherIds = [...new Set(rows.map((m) => {
      const c = connById[m.connection_id];
      return c ? (c.requester_id === userId ? c.recipient_id : c.requester_id) : null;
    }).filter(Boolean))];
    const names = {};
    if (otherIds.length) {
      const { data } = await supabase.from("user_profiles").select("user_id, username").in("user_id", otherIds);
      for (const p of data || []) names[p.user_id] = p.username;
    }
    return rows.map((m) => {
      const c = connById[m.connection_id];
      const other = c ? (c.requester_id === userId ? c.recipient_id : c.requester_id) : null;
      return { to: names[other] || null, content: m.content, sent_at: m.created_at ?? null };
    });
  });

  const featureRequests = await section("feature_requests", async () => {
    const mine = await fetchAll(() => supabase.from("feature_requests").select("*").eq("user_id", userId));
    const votes = await fetchAll(() => supabase.from("feature_request_votes").select("feature_request_id, created_at").eq("user_id", userId));
    const ids = [...new Set(votes.map((v) => v.feature_request_id))];
    const titles = {};
    if (ids.length) {
      const { data } = await supabase.from("feature_requests").select("id, title").in("id", ids);
      for (const r of data || []) titles[r.id] = r.title;
    }
    return {
      submitted: mine.map(({ user_id, ...r }) => r),
      voted_for: votes.map((v) => ({ title: titles[v.feature_request_id] || null, voted_at: v.created_at ?? null })),
    };
  }, { submitted: [], voted_for: [] });

  const notifications = await section("notifications", () =>
    fetchAll(() => supabase.from("notifications").select("*").eq("user_id", userId))
      .then((rows) => rows.map(({ user_id, ...r }) => r))
  );

  const importHistory = await section("import_history", () =>
    fetchAll(() => supabase.from("import_jobs").select("id, source, status, total_records, matched_records, unmatched_records, created_at, completed_at").eq("user_id", userId))
      .then((rows) => rows.map(({ id, ...r }) => r))
  );

  return {
    format: "scenera-export",
    format_version: 2,
    exported_at: new Date().toISOString(),
    account,
    profile,
    counts: {
      shows: watchlist.length,
      watched_episodes: watchedEpisodes.length,
      movies: movies.length,
      comments: comments.length,
    },
    watchlist,
    watched_episodes: watchedEpisodes,
    episode_rewatches: rewatches,
    movies,
    comments,
    comment_likes: commentLikes,
    favorite_characters: favoriteCharacters,
    friends,
    messages_sent: messagesSent,
    feature_requests: featureRequests,
    notifications,
    import_history: importHistory,
    ...(notes.length ? { notes } : {}),
  };
}

module.exports = { buildAccountExport };
