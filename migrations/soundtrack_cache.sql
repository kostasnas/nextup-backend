-- Shared soundtrack cache (27 Oct 2026): what the server finds about a title's soundtrack (the album and its songs, the
-- songs that play in the story) is kept here once, for everybody. The first person to open a title makes the lookup, every
-- later person (and every server restart) reads it from here. Run this in the Supabase SQL editor.
-- The backend uses its own connection (bypasses RLS); RLS is on with no policies, so nothing is reachable from a browser.
-- Without this table the feature still works, it just keeps everything in memory only.

create table if not exists soundtrack_cache (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table soundtrack_cache enable row level security;
