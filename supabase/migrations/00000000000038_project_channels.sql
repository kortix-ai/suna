do $$
begin
  create type kortix.project_channel_platform as enum ('slack', 'telegram', 'msteams', 'discord');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type kortix.project_channel_event_status as enum ('queued', 'fired', 'failed');
exception
  when duplicate_object then null;
end
$$;

create table if not exists kortix.project_channels (
  channel_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  platform kortix.project_channel_platform not null,
  external_channel_id varchar(255) not null,
  external_team_id varchar(255),
  name varchar(255),
  config jsonb default '{}'::jsonb,
  agent_name varchar(128) not null default 'default',
  prompt_template text not null,
  enabled boolean not null default true,
  status kortix.integration_status not null default 'active',
  created_by uuid,
  metadata jsonb default '{}'::jsonb,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_channels_account
  on kortix.project_channels(account_id);

create index if not exists idx_project_channels_project
  on kortix.project_channels(project_id);

create index if not exists idx_project_channels_platform
  on kortix.project_channels(platform);

create unique index if not exists idx_project_channels_project_platform_external
  on kortix.project_channels(project_id, platform, external_channel_id);

create table if not exists kortix.project_channel_events (
  event_id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references kortix.project_channels(channel_id) on delete cascade,
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  platform kortix.project_channel_platform not null,
  external_message_id varchar(255),
  status kortix.project_channel_event_status not null default 'queued',
  payload jsonb default '{}'::jsonb,
  rendered_prompt text,
  session_id text references kortix.project_sessions(session_id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_channel_events_channel
  on kortix.project_channel_events(channel_id);

create index if not exists idx_project_channel_events_project_status
  on kortix.project_channel_events(project_id, status);

create index if not exists idx_project_channel_events_status_created
  on kortix.project_channel_events(status, created_at);

create index if not exists idx_project_channel_events_external
  on kortix.project_channel_events(platform, external_message_id);
