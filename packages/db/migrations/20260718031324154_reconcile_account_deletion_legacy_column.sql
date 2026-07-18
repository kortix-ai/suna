-- Migration: reconcile_account_deletion_legacy_column
--
-- Dev and staging were onboarded from the legacy account-deletion table and
-- still require deletion_scheduled_for even though the current repository
-- writes the canonical scheduled_for column. Production already has the
-- legacy column nullable, and fresh databases no longer contain it.
--
-- mixed-version-safe: Current and previously deployed API versions only read
-- and write scheduled_for; making the retired compatibility column nullable
-- preserves old rows and is already the production schema state.

set lock_timeout = '2s';
set statement_timeout = '30s';

do $$
begin
  if exists (
    select 1
    from pg_attribute
    where attrelid = 'kortix.account_deletion_requests'::regclass
      and attname = 'deletion_scheduled_for'
      and not attisdropped
      and attnotnull
  ) then
    alter table kortix.account_deletion_requests
      alter column deletion_scheduled_for drop not null;
  end if;
end
$$;
