-- ============================================================
-- Nextup — Supabase schema (core tracking + import)
-- ============================================================

-- Shows are cached locally once matched to TMDB, so we don't
-- re-hit the TMDB API for every user who tracks the same show.
create table shows (
  id uuid primary key default gen_random_uuid(),
  tmdb_id integer unique not null,
  title text not null,
  poster_path text,
  network text,
  status text, -- 'returning', 'ended', 'canceled'
  created_at timestamptz default now()
);

create table episodes (
  id uuid primary key default gen_random_uuid(),
  show_id uuid references shows(id) on delete cascade,
  tmdb_episode_id integer,
  season_number integer not null,
  episode_number integer not null,
  air_date date,
  title text,
  unique (show_id, season_number, episode_number)
);

create table user_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  show_id uuid references shows(id) on delete cascade,
  status text not null default 'watching', -- 'watching' | 'completed' | 'planned' | 'dropped'
  created_at timestamptz default now(),
  unique (user_id, show_id)
);

create table watched_episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  episode_id uuid references episodes(id) on delete cascade,
  watched_at timestamptz not null default now(),
  rating numeric(3,1), -- optional, 0-10, from import or manual
  source text default 'manual', -- 'manual' | 'import_tvtime'
  unique (user_id, episode_id)
);

-- One row per uploaded file. Lets the user see history / retry / undo an import.
create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  source text not null default 'tvtime',
  status text not null default 'pending', -- 'pending' | 'parsing' | 'matching' | 'needs_review' | 'completed' | 'failed'
  total_records integer default 0,
  matched_records integer default 0,
  unmatched_records integer default 0,
  raw_file_path text, -- path in Supabase Storage
  error text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- Rows the fuzzy-matcher couldn't confidently resolve to a TMDB show.
-- Surfaced to the user as a manual "pick the right show" step.
create table import_unmatched (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid references import_jobs(id) on delete cascade,
  raw_title text not null,
  raw_season integer,
  raw_episode integer,
  raw_watched_at timestamptz,
  candidate_tmdb_ids integer[], -- top fuzzy-match candidates shown to user
  resolved_tmdb_id integer,
  resolved boolean default false
);

-- RLS: users only see their own data
alter table user_watchlist enable row level security;
alter table watched_episodes enable row level security;
alter table import_jobs enable row level security;
alter table import_unmatched enable row level security;

create policy "own watchlist" on user_watchlist for all using (auth.uid() = user_id);
create policy "own watched episodes" on watched_episodes for all using (auth.uid() = user_id);
create policy "own import jobs" on import_jobs for all using (auth.uid() = user_id);
create policy "own unmatched rows" on import_unmatched for all using (
  auth.uid() = (select user_id from import_jobs where import_jobs.id = import_job_id)
);
