do $$
begin
  create type kortix.project_trigger_type as enum ('cron', 'webhook');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type kortix.project_trigger_event_status as enum ('queued', 'fired', 'failed');
exception
  when duplicate_object then null;
end
$$;

create table if not exists kortix.project_triggers (
  trigger_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  type kortix.project_trigger_type not null,
  config jsonb default '{}'::jsonb,
  agent_name varchar(128) not null default 'default',
  prompt_template text not null,
  enabled boolean not null default true,
  created_by uuid,
  metadata jsonb default '{}'::jsonb,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_triggers_account
  on kortix.project_triggers(account_id);

create index if not exists idx_project_triggers_project
  on kortix.project_triggers(project_id);

create index if not exists idx_project_triggers_type_enabled
  on kortix.project_triggers(type, enabled);

create table if not exists kortix.project_trigger_events (
  event_id uuid primary key default gen_random_uuid(),
  trigger_id uuid not null references kortix.project_triggers(trigger_id) on delete cascade,
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  status kortix.project_trigger_event_status not null default 'queued',
  payload jsonb default '{}'::jsonb,
  rendered_prompt text,
  session_id text references kortix.project_sessions(session_id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_trigger_events_trigger
  on kortix.project_trigger_events(trigger_id);

create index if not exists idx_project_trigger_events_project_status
  on kortix.project_trigger_events(project_id, status);

create index if not exists idx_project_trigger_events_status_created
  on kortix.project_trigger_events(status, created_at);
