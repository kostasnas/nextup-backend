-- My Top 10: lists can have their own name ("2025-26"). Run in the Supabase SQL editor (19 Nov 2026).
-- `year` stays the list's key: 0 = all time, 1900-2100 = a plain year, base*100+n (190001-210099) = a named list.
alter table user_top_movie_lists add column if not exists label text check (label is null or char_length(label) <= 12);
alter table user_top_movie_lists drop constraint if exists user_top_movie_lists_year_check;
alter table user_top_movie_lists add constraint user_top_movie_lists_year_check
  check (year = 0 or (year between 1900 and 2100) or (year between 190001 and 210099));
