-- "Send to friend" (27 Oct 2026): a chat message can carry a small card for an episode, a movie or a show, so the
-- friend sees which one it is about. The title and poster are copied onto the message, so the chat needs no
-- extra lookups. Run this in the Supabase SQL editor. Safe to run more than once.
alter table messages add column if not exists ref_kind text check (ref_kind in ('episode', 'movie', 'show'));
alter table messages add column if not exists ref_tmdb_id integer;
alter table messages add column if not exists ref_season integer;
alter table messages add column if not exists ref_episode integer;
alter table messages add column if not exists ref_title text;
alter table messages add column if not exists ref_poster text;
