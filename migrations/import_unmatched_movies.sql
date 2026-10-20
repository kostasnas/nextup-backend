-- Titles of movies that an import could not match (the import itself only counted them).
-- Only the server (service role) reads and writes this table; people never see it.
create table if not exists import_unmatched_movies (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid references import_jobs(id) on delete cascade,
  raw_title text not null,
  raw_year integer,
  created_at timestamptz not null default now()
);
create index if not exists import_unmatched_movies_job_idx on import_unmatched_movies (import_job_id);
alter table import_unmatched_movies enable row level security; -- no policies: not readable with the public key
