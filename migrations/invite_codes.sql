-- Invite-a-friend: one short random code per user. Run once in the Supabase SQL editor.
create table if not exists invite_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

-- Only the backend (service role / direct connection) reads this table.
alter table invite_codes enable row level security;
