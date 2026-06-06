-- Shared (cross-replica) Slack streaming state. The agent's slack step/send
-- relays land on any API replica behind the load balancer, so the per-turn
-- stream handle + the inbound-event dedup set must be shared, not in-process.

create table if not exists kortix.chat_turn_streams (
  session_id         text primary key,
  project_id         uuid not null,
  team_id            varchar(128) not null,
  channel            varchar(128) not null,
  trigger_ts         varchar(64) not null,
  message_ts         varchar(64),
  streaming          boolean not null default false,
  placeholder_active boolean not null default false,
  finalized          boolean not null default false,
  steps              jsonb not null default '[]'::jsonb,
  originating_event  jsonb not null,
  expires_at         timestamptz not null,
  updated_at         timestamptz not null default now()
);
create index if not exists idx_chat_turn_streams_expiry on kortix.chat_turn_streams (expires_at);

create table if not exists kortix.chat_event_dedup (
  event_id   text primary key,
  expires_at timestamptz not null
);
create index if not exists idx_chat_event_dedup_expiry on kortix.chat_event_dedup (expires_at);
