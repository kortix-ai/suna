do $$
begin
  create type kortix.project_secret_scope as enum ('runtime', 'llm_provider', 'connector');
exception
  when duplicate_object then null;
end
$$;

create table if not exists kortix.project_secrets (
  secret_id uuid primary key default gen_random_uuid(),
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  name varchar(64) not null,
  value_enc text not null,
  scope kortix.project_secret_scope not null default 'runtime',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idx_project_secrets_project_name unique (project_id, name)
);

create index if not exists idx_project_secrets_project on kortix.project_secrets(project_id);
create index if not exists idx_project_secrets_scope on kortix.project_secrets(scope);
