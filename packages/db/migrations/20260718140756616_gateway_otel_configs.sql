-- Migration: gateway_otel_configs
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand/contract checklist -- delete lines that don't apply, keep the rest honest:
--   [ ] New/renamed column is nullable OR has a DEFAULT (no bare NOT NULL on an
--       existing populated table without a prior backfill migration).
--   [ ] New index: use `pnpm migrate:create gateway_otel_configs_index --concurrent`
--       instead of a plain CREATE INDEX in this file -- see the .concurrent.ts
--       escape hatch. A plain CREATE INDEX on an existing table blocks writes
--       for the duration of the build.
--   [ ] Adding a FK or a new constraint on an existing table: add it NOT VALID,
--       VALIDATE CONSTRAINT in a follow-up migration (constraint-missing-not-valid).
--   [ ] Dropping/renaming a column, table, constraint, unique index, or enum
--       value: confirm every code path that reads or writes it was removed in
--       a PRIOR deploy that is ALREADY LIVE (expand -> contract, never both in
--       one migration). If old code MIGHT still be running when this deploys,
--       add the line below (this is enforced -- CI fails without it on any
--       DROP/RENAME/ALTER ... TYPE/DROP NOT NULL):
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Adding an enum value (ALTER TYPE ... ADD VALUE): a faked/rebaselined
--       environment can silently skip it (see the prod sandbox_provider
--       "platinum" 22P02 incident) -- this is enforced, add:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- Write your SQL below.
-- New table, pure CREATE -- nothing to expand/contract, no existing rows.

CREATE TABLE "kortix"."gateway_otel_configs" (
  "project_id" uuid PRIMARY KEY NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "endpoint" text,
  "headers_enc" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
