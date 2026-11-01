-- Movie franchises (1 Nov 2026): which TMDB collection ("The Dark Knight Collection") each movie belongs to,
-- so the Movies tab can show "Your sagas" with progress (2/3 watched). Run this in the Supabase SQL editor.
-- The backend fills it by itself: when someone opens the Movies tab (a batch of that person's movies),
-- when a single movie is added, and with the admin call below for everything already stored:
--   https://<backend>/admin/backfill-movie-collections?secret=<CRON_SECRET>
-- repeated until "remaining" is 0 (60 movies per call).
-- collection_checked_at is set once TMDB has been asked, also when the movie has no franchise (collection_id stays null),
-- so a movie is never asked twice.
alter table movies add column if not exists collection_id integer;
alter table movies add column if not exists collection_name text;
alter table movies add column if not exists collection_checked_at timestamptz;
create index if not exists movies_collection_idx on movies (collection_id) where collection_id is not null;
