-- Soundtrack search log (28 Oct 2026): one row per fresh lookup (not for cached ones) with where the album came from
-- ('deezer', 'itunes' or 'none') and how many albums were found. Used to see which titles find nothing.
-- The server creates this table by itself on first use, so running this is optional. Safe to run more than once.
create table if not exists soundtrack_search_log (
  id bigserial primary key,
  title text not null,
  year integer,
  composers text,
  source text not null,
  found integer not null,
  created_at timestamptz not null default now()
);
alter table soundtrack_search_log enable row level security;
