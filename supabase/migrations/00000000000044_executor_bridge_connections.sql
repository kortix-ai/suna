-- Executor bridge v1: project-scoped connections and MCP-visible tools.
-- This intentionally keeps OAuth/vault/policy/approval concerns out of the
-- first persistence slice. Those should be layered in after the bridge is
-- proven end-to-end.

create table if not exists kortix.project_connections (
  connection_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  name varchar(128) not null,
  source_type varchar(32) not null default 'static',
  config jsonb default '{}'::jsonb,
  enabled boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_connections_account
  on kortix.project_connections(account_id);
create index if not exists idx_project_connections_project
  on kortix.project_connections(project_id);
create unique index if not exists idx_project_connections_project_name
  on kortix.project_connections(project_id, name);

create table if not exists kortix.project_connection_tools (
  tool_id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references kortix.project_connections(connection_id) on delete cascade,
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  name varchar(192) not null,
  description text,
  input_schema jsonb default '{}'::jsonb,
  implementation jsonb default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_connection_tools_connection
  on kortix.project_connection_tools(connection_id);
create index if not exists idx_project_connection_tools_project
  on kortix.project_connection_tools(project_id);
create unique index if not exists idx_project_connection_tools_project_name
  on kortix.project_connection_tools(project_id, name);

