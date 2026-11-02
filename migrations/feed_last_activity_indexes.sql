-- Activity Feed: newest watch per friend as an index probe instead of a scan of every row.
create index if not exists watched_episodes_user_watched_idx
  on watched_episodes (user_id, watched_at desc);

create index if not exists user_movie_watchlist_user_watched_idx
  on user_movie_watchlist (user_id, watched_at desc)
  where status = 'watched' and watched_at is not null;
