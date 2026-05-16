create table if not exists kortix.project_connectors (
  connector_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  provider_name varchar(50) not null default 'pipedream',
  app varchar(255) not null,
  app_name varchar(255),
  provider_account_id varchar(255) not null,
  label varchar(255),
  status kortix.integration_status not null default 'active',
  scopes jsonb default '[]'::jsonb,
  metadata jsonb default '{}'::jsonb,
  created_by uuid,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_connectors_account
  on kortix.project_connectors(account_id);

create index if not exists idx_project_connectors_project
  on kortix.project_connectors(project_id);

create index if not exists idx_project_connectors_app
  on kortix.project_connectors(project_id, app);

create index if not exists idx_project_connectors_provider_account
  on kortix.project_connectors(provider_account_id);

create unique index if not exists idx_project_connectors_project_provider_account
  on kortix.project_connectors(project_id, provider_name, provider_account_id);
