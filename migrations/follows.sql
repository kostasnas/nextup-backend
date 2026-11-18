-- Follow: one-way follows, user blocks and profile reports. Run once in the Supabase SQL editor.
-- Only the backend (direct connection / service role) reads and writes these tables.

create table if not exists follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followed_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);
create index if not exists follows_followed_idx on follows (followed_id, created_at desc);
create index if not exists follows_follower_idx on follows (follower_id, created_at desc);
alter table follows enable row level security;

create table if not exists user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on user_blocks (blocked_id);
alter table user_blocks enable row level security;

create table if not exists user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_id uuid not null references auth.users(id) on delete cascade,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists user_reports_reported_idx on user_reports (reported_id, created_at desc);
alter table user_reports enable row level security;
