-- Titles an import could not find on TMDB (usually because they are not released yet, e.g. things a
-- person had on a "planned" list in another app). Kept per person so pendingTitles.js can look again
-- every week and add them to the person's Planned list as soon as TMDB has them.
create table if not exists pending_titles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('movie', 'show')),
  title text not null,
  year integer,
  source text,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  attempts integer not null default 0,
  resolved_at timestamptz,
  resolved_note text
);
create index if not exists pending_titles_open_idx on pending_titles (last_attempt_at) where resolved_at is null;
create index if not exists pending_titles_user_idx on pending_titles (user_id);
alter table pending_titles enable row level security;
create policy "own pending titles" on pending_titles for select using (auth.uid() = user_id);
