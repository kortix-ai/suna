-- Ensure billing customers table exists in kortix schema.
-- Needed by billing setup/checkout flows in cloud billing mode.

create schema if not exists kortix;

create table if not exists kortix.billing_customers (
  account_id uuid not null,
  id text primary key,
  email text,
  active boolean,
  provider text
);

create index if not exists idx_kortix_billing_customers_account_id
  on kortix.billing_customers(account_id);
