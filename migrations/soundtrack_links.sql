-- Share link for a person's saved soundtrack songs (30 Oct 2026): one unguessable token per person. Anyone with the
-- link sees the list of songs (title + artist, grouped by show / movie) and nothing else. Run in the Supabase SQL editor.
create table if not exists user_soundtrack_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table user_soundtrack_links enable row level security;
