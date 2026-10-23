-- Custom lists (23 Oct 2026): people's own named collections of shows and movies ("the best of the best",
-- "Korean for the weekend"), like TV Time's lists. Run this in the Supabase SQL editor.
-- The backend reads and writes these with its own connection (bypasses RLS), so RLS is on with no policies:
-- nothing is reachable straight from a browser.

create table if not exists user_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  is_public boolean not null default false,
  share_slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_lists_user_idx on user_lists (user_id, updated_at desc);

-- Title and poster are copied onto the row so a list can hold titles that aren't tracked and needs no joins.
create table if not exists user_list_items (
  list_id uuid not null references user_lists(id) on delete cascade,
  kind text not null check (kind in ('show', 'movie')),
  tmdb_id integer not null,
  title text not null,
  poster_path text,
  position integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (list_id, kind, tmdb_id)
);

create index if not exists user_list_items_order_idx on user_list_items (list_id, position);

alter table user_lists enable row level security;
alter table user_list_items enable row level security;
