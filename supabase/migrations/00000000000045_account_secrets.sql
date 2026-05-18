do $$
begin
  create type kortix.account_secret_kind as enum ('api_key', 'oauth_subscription');
exception
  when duplicate_object then null;
end
$$;

create table if not exists kortix.account_secrets (
  secret_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  name varchar(64) not null,
  value_enc text not null,
  kind kortix.account_secret_kind not null default 'api_key',
  provider varchar(32),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idx_account_secrets_account_name unique (account_id, name)
);

create index if not exists idx_account_secrets_account on kortix.account_secrets(account_id);
create index if not exists idx_account_secrets_kind on kortix.account_secrets(kind);
