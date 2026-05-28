-- Personal Access Tokens (PATs) for the Kortix CLI.
-- Account-scoped (not sandbox-scoped like kortix.api_keys), minted from the
-- dashboard, used as Authorization: Bearer <kortix_pat_...>.
--
-- Stores only the HMAC-SHA256 hash of the secret. The plaintext is shown
-- ONCE at creation time.

create table if not exists kortix.account_tokens (
  token_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  user_id uuid not null,                                   -- who minted it; informational
  name varchar(255) not null,                              -- user-visible label
  public_key varchar(64) not null,                          -- pk_... (safe to display)
  secret_key_hash varchar(128) not null,                    -- HMAC of the kortix_pat_... secret
  status kortix.api_key_status default 'active' not null,
  expires_at timestamp with time zone,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  revoked_at timestamp with time zone
);

create unique index if not exists idx_account_tokens_public_key
  on kortix.account_tokens(public_key);
create index if not exists idx_account_tokens_secret_hash
  on kortix.account_tokens(secret_key_hash);
create index if not exists idx_account_tokens_account
  on kortix.account_tokens(account_id);
create index if not exists idx_account_tokens_user
  on kortix.account_tokens(user_id);
