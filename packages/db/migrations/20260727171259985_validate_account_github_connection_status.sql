-- Migration: validate_account_github_connection_status
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."account_github_installations"
  VALIDATE CONSTRAINT "account_github_installations_connection_status_check";
