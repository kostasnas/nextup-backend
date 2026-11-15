-- Cache of TVmaze cast lists (character pictures), so a show is looked up at TVmaze once for everyone and the
-- answer survives backend restarts. Written and read only by the backend (direct Postgres connection).
-- Run once in the Supabase SQL editor.

create table if not exists tvmaze_cast_cache (
  cache_key text primary key,          -- "<imdb id>|<tvdb id>"
  cast_json jsonb not null,            -- [{ actor, character, characterImage }]
  fetched_at timestamptz not null default now()
);

alter table tvmaze_cast_cache enable row level security;
