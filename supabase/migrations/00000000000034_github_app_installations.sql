create table if not exists kortix.account_github_installations (
  account_id uuid primary key references kortix.accounts(account_id) on delete cascade,
  installation_id text not null,
  owner_login varchar(255) not null,
  owner_type varchar(32) not null default 'Organization',
  repository_selection varchar(32),
  permissions jsonb default '{}'::jsonb,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_account_github_installations_installation
  on kortix.account_github_installations(installation_id);

create index if not exists idx_account_github_installations_owner
  on kortix.account_github_installations(owner_login);
