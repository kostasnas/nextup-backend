-- Badges (21 Oct 2026): origin country per show, so "Anime Fan" (JP + Animation) and "K-Drama Fan"
-- (KR + Drama) can be counted. Run this in the Supabase SQL editor, then open
--   https://<backend>/admin/backfill-show-origin?secret=<CRON_SECRET>
-- repeatedly until "remaining" is 0 (60 shows per call). New and re-synced shows fill it automatically.
alter table shows add column if not exists origin_country text[];
