-- Migration: isolate_codex_subscription_credentials
set lock_timeout = '2s';
set statement_timeout = '30s';

update "kortix"."project_secrets"
set
  "strategy" = 'broker',
  "consumer" = 'llm_gateway',
  "egress_policy" = null,
  "handle_prefix" = null,
  "strategy_locked" = true,
  "rotated_at" = null,
  "updated_at" = now()
where
  "name" = 'CODEX_AUTH_JSON'
  and (
    "strategy" <> 'broker'
    or "consumer" is distinct from 'llm_gateway'::"kortix"."project_secret_consumer"
    or "egress_policy" is not null
    or "handle_prefix" is not null
    or not "strategy_locked"
  );
