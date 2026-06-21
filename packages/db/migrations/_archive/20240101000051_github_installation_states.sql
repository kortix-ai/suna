create table if not exists kortix.account_github_installation_states (
  state_nonce text primary key,
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  user_id uuid not null,
  installation_id text,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_account_github_installation_states_account
  on kortix.account_github_installation_states(account_id);

create index if not exists idx_account_github_installation_states_expires_at
  on kortix.account_github_installation_states(expires_at);
