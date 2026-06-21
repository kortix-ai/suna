create table if not exists kortix.audit_events (
  event_id uuid primary key default gen_random_uuid(),
  account_id uuid references kortix.accounts(account_id) on delete set null,
  actor_user_id uuid,
  action text not null,
  resource_type text not null,
  resource_id text,
  before jsonb,
  after jsonb,
  ip text,
  user_agent text,
  metadata jsonb default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_events_account_time
  on kortix.audit_events(account_id, occurred_at);

create index if not exists idx_audit_events_actor_time
  on kortix.audit_events(actor_user_id, occurred_at);

create index if not exists idx_audit_events_resource
  on kortix.audit_events(resource_type, resource_id);

create table if not exists kortix.usage_events (
  event_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid references kortix.projects(project_id) on delete set null,
  session_id text,
  actor_user_id uuid,
  provider text not null,
  model text not null,
  route text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  streaming boolean not null default false,
  upstream_status integer,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_usage_events_account_time
  on kortix.usage_events(account_id, created_at);

create index if not exists idx_usage_events_project_time
  on kortix.usage_events(project_id, created_at);

create index if not exists idx_usage_events_session
  on kortix.usage_events(session_id);

create index if not exists idx_usage_events_model
  on kortix.usage_events(provider, model);
