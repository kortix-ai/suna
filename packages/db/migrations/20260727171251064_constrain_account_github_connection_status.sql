-- Migration: constrain_account_github_connection_status
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."account_github_installations"
  ADD CONSTRAINT "account_github_installations_connection_status_check"
  CHECK (
    "connection_status" in (
      'connecting',
      'connected',
      'needs_reconnect',
      'error',
      'disconnected'
    )
  )
  NOT VALID;
