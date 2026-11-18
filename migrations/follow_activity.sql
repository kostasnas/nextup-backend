-- Follow: per-follower permission to see someone's activity. Run once in the Supabase SQL editor.
-- A row means: owner_id lets follower_id see their show/movie titles and latest watch (last 48 hours).
create table if not exists follow_activity_grants (
  owner_id uuid not null references auth.users(id) on delete cascade,
  follower_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, follower_id),
  check (owner_id <> follower_id)
);
create index if not exists follow_activity_grants_follower_idx on follow_activity_grants (follower_id);
alter table follow_activity_grants enable row level security;
