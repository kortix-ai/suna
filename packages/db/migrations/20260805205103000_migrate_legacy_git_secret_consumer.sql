-- Migration: migrate_legacy_git_secret_consumer
set lock_timeout = '2s';
set statement_timeout = '30s';

update "kortix"."project_secrets"
set
  "strategy" = 'broker',
  "consumer" = 'git_proxy',
  "egress_policy" = null,
  "handle_prefix" = null,
  "updated_at" = now()
where
  "name" = 'KORTIX_GIT_AUTH_TOKEN'
  and "owner_user_id" is null
  and (
    "strategy" <> 'broker'
    or "consumer" is distinct from 'git_proxy'::"kortix"."project_secret_consumer"
    or "egress_policy" is not null
    or "handle_prefix" is not null
  );
