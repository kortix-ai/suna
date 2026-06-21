create table if not exists kortix.project_git_connections (
  connection_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  provider varchar(32) not null,
  repo_url text not null,
  repo_owner varchar(255),
  repo_name varchar(255),
  external_repo_id text,
  default_branch varchar(255) not null default 'main',
  auth_method varchar(64) not null,
  installation_id text,
  credential_ref text,
  permissions jsonb default '{}'::jsonb,
  visibility varchar(32),
  webhook_id text,
  status varchar(32) not null default 'connected',
  last_validated_at timestamptz,
  last_error_code varchar(64),
  last_error_message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_git_connections_account
  on kortix.project_git_connections(account_id);

create unique index if not exists idx_project_git_connections_project
  on kortix.project_git_connections(project_id);

create index if not exists idx_project_git_connections_provider_repo
  on kortix.project_git_connections(provider, external_repo_id);

create index if not exists idx_project_git_connections_status
  on kortix.project_git_connections(status);

create table if not exists kortix.project_git_credentials (
  credential_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  provider varchar(32) not null,
  auth_method varchar(64) not null default 'token',
  value_enc text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_git_credentials_account
  on kortix.project_git_credentials(account_id);

create unique index if not exists idx_project_git_credentials_project_provider
  on kortix.project_git_credentials(project_id, provider);
