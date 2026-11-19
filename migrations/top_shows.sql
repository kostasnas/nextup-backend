-- My Top 10 series (19 Nov 2026): same as the movie lists (see top_movies.sql), for TV series. Run in the Supabase SQL editor.
-- `year` is the list's key: 0 = all time, 1900-2100 = a plain year, base*100+n (190001-210099) = a named list like "2025-26".
create table if not exists user_top_show_lists (
  user_id uuid not null references auth.users(id) on delete cascade,
  year integer not null check (year = 0 or (year between 1900 and 2100) or (year between 190001 and 210099)),
  label text check (label is null or char_length(label) <= 12),
  is_public boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);

create table if not exists user_top_shows (
  user_id uuid not null,
  year integer not null,
  position smallint not null check (position between 1 and 10),
  tmdb_id integer not null,
  title text not null,
  poster_path text,
  release_year integer,
  primary key (user_id, year, position),
  unique (user_id, year, tmdb_id),
  foreign key (user_id, year) references user_top_show_lists(user_id, year) on delete cascade
);

alter table user_top_show_lists enable row level security;
alter table user_top_shows enable row level security;
