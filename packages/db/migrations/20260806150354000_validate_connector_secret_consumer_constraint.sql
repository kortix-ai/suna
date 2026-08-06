-- Migration: validate_connector_secret_consumer_constraint
--
-- Validate the constraint in a separate transaction from its creation. This
-- avoids holding the creation transaction open while PostgreSQL scans rows.
set lock_timeout = '2s';
set statement_timeout = '30s';

alter table kortix.project_secrets
  validate constraint project_secrets_egress_policy_required;
