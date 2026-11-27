-- Community suggestions (27 Nov 2026): anyone can put a series or movie on one shared, anonymous list ("Suggest to
-- everyone"); other people see a weekly set of picks, add titles to planned, and rate them. The rating is seen only by
-- the people who suggested the title. Run this in the Supabase SQL editor.
-- The backend reads and writes these with its own connection (bypasses RLS), so RLS is on with no policies.

create table if not exists community_suggestions (
  id bigserial primary key,
  kind text not null check (kind in ('tv', 'movie')),
  tmdb_id integer not null,
  title text not null,
  poster_path text,
  release_year integer,
  suggest_count integer not null default 1,
  first_suggested_at timestamptz not null default now(),
  last_suggested_at timestamptz not null default now(),
  unique (kind, tmdb_id)
);
create index if not exists community_suggestions_recent_idx on community_suggestions (kind, last_suggested_at desc);

-- Who suggested what (never shown to other people). One row per person and title.
create table if not exists community_suggesters (
  suggestion_id bigint not null references community_suggestions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);
create index if not exists community_suggesters_user_idx on community_suggesters (user_id, created_at desc);

-- What each person did with a suggestion: added it to planned, hid it ("Not for me"), rated it 1-5.
create table if not exists community_responses (
  suggestion_id bigint not null references community_suggestions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added boolean not null default false,
  dismissed boolean not null default false,
  rating smallint check (rating between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);

-- The weekly "Picks for you" set, frozen per person, kind and week (Monday) so it stays the same all week.
create table if not exists community_pick_batches (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('tv', 'movie')),
  week_start date not null,
  suggestion_ids bigint[] not null,
  primary key (user_id, kind, week_start)
);

alter table community_suggestions enable row level security;
alter table community_suggesters enable row level security;
alter table community_responses enable row level security;
alter table community_pick_batches enable row level security;

-- The whole feature is OFF until you switch it on (the app shows the Suggest tab only when this flag is true).
insert into feature_flags (key, enabled, note) values
  ('community_suggest', false, 'Suggest tab + "Suggest to everyone" (community suggestions)')
on conflict (key) do nothing;
-- Switch on:  update feature_flags set enabled = true, updated_at = now() where key = 'community_suggest';

-- When someone added a suggestion to planned (for the monthly Top Suggester title). Older rows fall back to updated_at.
alter table community_responses add column if not exists added_at timestamptz;
update community_responses set added_at = updated_at where added and added_at is null;
