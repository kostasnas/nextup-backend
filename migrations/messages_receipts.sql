-- Delivery and read ticks for friend chat (like Viber): one grey tick = sent, two grey = it reached the other
-- person's app, two blue = they opened the conversation. Safe to run more than once.
alter table messages add column if not exists delivered_at timestamptz;
alter table messages add column if not exists read_at timestamptz;

-- Messages that already exist count as delivered and read, so old conversations do not show grey ticks.
update messages set delivered_at = created_at, read_at = created_at where delivered_at is null and read_at is null;
