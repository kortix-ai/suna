-- Migration: remove_connector_provider_shopify
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Removes the 'shopify' connector provider that 20261026092023000 added. The
-- native Shopify connector is gone, so no code reads or writes the value.
-- Only dev ever held it (the connector never left dev), so the rows deleted
-- here are dev test data; on every other database both statements match
-- nothing. Session bindings reference connectors ON DELETE RESTRICT, so they
-- go first. Connections, credentials, actions, policies and approvals cascade;
-- call history keeps its rows with connector_id set to NULL.
-- backfill-safe: kortix.connectors + its children; at most 2 connector rows
-- match (dev, measured 2026-10-26), 0 on staging, prod and self-host, so the
-- DELETEs finish in milliseconds and writers do not queue behind them.
DELETE FROM kortix.project_session_connector_bindings b
  USING kortix.connectors c
  WHERE b.connector_id = c.connector_id AND c.provider_type::text = 'shopify';--> statement-breakpoint
DELETE FROM kortix.connectors WHERE provider_type::text = 'shopify';--> statement-breakpoint

-- mixed-version-safe: no released code writes 'shopify'; staging and prod
-- never ran a build that did, and the rows that held it are deleted above.
ALTER TABLE ONLY kortix.connectors
  -- squawk-ignore changing-column-type
  ALTER COLUMN provider_type TYPE text USING provider_type::text;--> statement-breakpoint

DROP TYPE kortix.connector_provider;--> statement-breakpoint
CREATE TYPE kortix.connector_provider AS ENUM (
  'pipedream', 'composio', 'mcp', 'openapi', 'postman', 'graphql', 'http', 'channel', 'computer'
);--> statement-breakpoint

ALTER TABLE ONLY kortix.connectors
  -- squawk-ignore changing-column-type
  ALTER COLUMN provider_type TYPE kortix.connector_provider
    USING provider_type::kortix.connector_provider;
