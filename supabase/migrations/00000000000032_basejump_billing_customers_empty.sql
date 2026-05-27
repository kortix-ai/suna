-- Create empty basejump.billing_customers table.
-- Suna's reconcile-legacy-stripe-billing script and resolve-account
-- both query basejump.billing_customers, but no migration ever
-- creates it in basejump (only in kortix.). With billing disabled
-- this table just needs to exist and return 0 rows.

create schema if not exists basejump;

create table if not exists basejump.billing_customers (
  account_id uuid not null,
  id text primary key,
  email text,
  active boolean,
  provider text
);

create index if not exists idx_basejump_billing_customers_account_id
  on basejump.billing_customers(account_id);
