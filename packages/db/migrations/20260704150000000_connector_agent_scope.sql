-- Up Migration
--
-- Connector → agent access control (the connector-side agent gate, mirror of
-- project_secrets.agent_scope). A connector gains an `agent_scope` text[] column:
--       NULL / empty  = callable by ALL agents (the default)
--       ['a','b', …]  = callable ONLY by those agents' sessions (agent NAMES)
-- The executor gateway drops any /call whose running agent isn't listed, and the
-- connector catalog hides it from scoped-out agents. NULL keeps every existing
-- connector callable by all agents (additive narrowing, never widening).
--
-- Reconciled every sync from the toml [[connectors]].agent_scope for DECLARED
-- connectors (a dedicated column, so it reconciles in the always-written cheap
-- fields — unlike config jsonb, which only rewrites on a catalog re-fetch); set
-- DB-side for synthetic channel/computer connectors that have no manifest entry.

ALTER TABLE "kortix"."executor_connectors"
  ADD COLUMN IF NOT EXISTS "agent_scope" text[];

-- Down Migration
ALTER TABLE "kortix"."executor_connectors" DROP COLUMN IF EXISTS "agent_scope";
