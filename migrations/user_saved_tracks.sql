-- Saved soundtrack songs (27 Oct 2026): a person saves individual songs from a show's or movie's soundtrack and
-- finds them again, grouped by title, in the Soundtracks card on Profile. Run this in the Supabase SQL editor.
-- The backend reads and writes these with its own connection (bypasses RLS), so RLS is on with no policies:
-- nothing is reachable straight from a browser.

create table if not exists user_saved_tracks (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('show', 'movie')),
  tmdb_id integer not null,
  track_id bigint not null,            -- Deezer track id
  media_title text not null,           -- the show / movie the song belongs to (copied, so no joins are needed)
  poster_path text,
  track_title text not null,
  track_artist text,
  album_title text,
  cover_url text,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, tmdb_id, track_id)
);

create index if not exists user_saved_tracks_user_idx on user_saved_tracks (user_id, created_at desc);

alter table user_saved_tracks enable row level security;
