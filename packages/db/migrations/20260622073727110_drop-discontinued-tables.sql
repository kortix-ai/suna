-- Up Migration
--
-- Centralize on kortix.ts (85 tables) as the single source of truth. These 8
-- tables are discontinued: absent from prod, zero code references, and not
-- modeled in kortix.ts. Their only foreign keys are internal to this set
-- (executions -> triggers, vault_item_grants -> vault_items), so nothing kept
-- depends on them. Dropping aligns dev + a fresh baseline build to prod, which
-- is exactly what kortix.ts already models.

DROP TABLE IF EXISTS kortix.executions CASCADE;
DROP TABLE IF EXISTS kortix.triggers CASCADE;
DROP TABLE IF EXISTS kortix.vault_item_grants CASCADE;
DROP TABLE IF EXISTS kortix.vault_items CASCADE;
DROP TABLE IF EXISTS kortix.api_schema_migrations CASCADE;
DROP TABLE IF EXISTS kortix.channel_identity_map CASCADE;
DROP TABLE IF EXISTS kortix.credit_balance CASCADE;
DROP TABLE IF EXISTS kortix.woa_posts CASCADE;

-- Enum types now exclusive to the dropped tables (execution_status is shared
-- with a kept table, so it stays).
DROP TYPE IF EXISTS kortix.session_mode;
DROP TYPE IF EXISTS kortix.vault_item_kind;
DROP TYPE IF EXISTS kortix.woa_post_type;

-- Down Migration
-- Forward-only: these tables are discontinued and intentionally not recreatable.
