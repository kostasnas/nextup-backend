-- Speeds up "next unwatched episode" lookups (widget /widget/next-up) for people who track many shows.
-- Run once in the Supabase SQL editor. Safe to run again.
create index if not exists episodes_show_air_date_idx on episodes (show_id, air_date);
create index if not exists user_watchlist_user_status_idx on user_watchlist (user_id, status);
