-- Remote on/off switches for features. The app reads them through GET /config/flags (service role, so no policies are
-- needed). A feature that is not listed here counts as ON.
create table if not exists feature_flags (
  key text primary key,
  enabled boolean not null default true,
  note text,
  updated_at timestamptz not null default now()
);
alter table feature_flags enable row level security;

insert into feature_flags (key, enabled, note) values
  ('suggest_show', true, 'Suggest to a friend buttons on the show page'),
  ('episode_row_layout', true, 'List / horizontal toggle for episodes')
on conflict (key) do nothing;

-- To switch a feature off (takes effect within about a minute):
--   update feature_flags set enabled = false, updated_at = now() where key = 'suggest_show';
-- To switch it back on:
--   update feature_flags set enabled = true, updated_at = now() where key = 'suggest_show';
