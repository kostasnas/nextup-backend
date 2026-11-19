-- My Top 10 movies (19 Nov 2026): one ranked list of up to 10 movies per year (year 0 = "All time"),
-- like Letterboxd. Run this in the Supabase SQL editor.
-- The backend reads and writes these with its own connection (bypasses RLS), so RLS is on with no policies.

create table if not exists user_top_movie_lists (
  user_id uuid not null references auth.users(id) on delete cascade,
  year integer not null check (year = 0 or (year between 1900 and 2100)),
  is_public boolean not null default false, -- shown to the owner's followers
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);

-- Title and poster are copied onto the row so the list needs no joins and can hold untracked movies.
create table if not exists user_top_movies (
  user_id uuid not null,
  year integer not null,
  position smallint not null check (position between 1 and 10),
  tmdb_id integer not null,
  title text not null,
  poster_path text,
  release_year integer,
  primary key (user_id, year, position),
  unique (user_id, year, tmdb_id),
  foreign key (user_id, year) references user_top_movie_lists(user_id, year) on delete cascade
);

alter table user_top_movie_lists enable row level security;
alter table user_top_movies enable row level security;
