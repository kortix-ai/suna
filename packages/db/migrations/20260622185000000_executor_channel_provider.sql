-- Up Migration
--
-- Prod was baselined with an executor_connector_provider enum that predated
-- the native Slack channel connector. Fresh databases get `channel` from the
-- baseline, but faked-baseline environments need this forward-only enum backfill
-- before `syncProjectConnectors` can materialize provider_type='channel'.

ALTER TYPE kortix.executor_connector_provider ADD VALUE IF NOT EXISTS 'channel';

-- Down Migration
-- PostgreSQL enum values are intentionally forward-only here. Removing `channel`
-- would break the native Slack connector rows and any future channel providers.
