alter table kortix.account_github_installations
  add column if not exists installation_row_id uuid default gen_random_uuid();

update kortix.account_github_installations
set installation_row_id = gen_random_uuid()
where installation_row_id is null;

alter table kortix.account_github_installations
  alter column installation_row_id set not null;

alter table kortix.account_github_installations
  drop constraint if exists account_github_installations_pkey;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'account_github_installations_pkey'
      and conrelid = 'kortix.account_github_installations'::regclass
  ) then
    alter table kortix.account_github_installations
      add constraint account_github_installations_pkey primary key (installation_row_id);
  end if;
end $$;

drop index if exists kortix.idx_account_github_installations_installation;

create index if not exists idx_account_github_installations_account
  on kortix.account_github_installations(account_id);

create unique index if not exists idx_account_github_installations_account_installation
  on kortix.account_github_installations(account_id, installation_id);
