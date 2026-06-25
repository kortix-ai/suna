---
name: migration
description: "How to change the database schema in this repo. Current engine: node-pg-migrate, with SQL generated from Drizzle schema changes when possible. Load whenever you add/alter/drop a table, column, enum, index, constraint, RLS/function/grant, or any file under packages/db/migrations."
---

# Database migrations

The canonical, detailed runbook is `packages/db/MIGRATIONS.md`. This skill is a
short safety wrapper; if anything here seems incomplete, trust that file and the
current `package.json` scripts.

## Current model

- **Engine:** node-pg-migrate, invoked by `packages/db/scripts/migrate.ts`.
- **Schema source:** `packages/db/src/schema/kortix.ts` for the Drizzle-modeled
  `kortix` schema.
- **Migration files:** immutable SQL files in `packages/db/migrations/`, named
  with a 17-digit UTC timestamp (`YYYYMMDDHHMMSSmmm_slug.sql`).
- **Applied-state table:** `kortix_migrations.pgmigrations` (node-pg-migrate
  tracks migration names; it does not checksum file contents).
- **Deploy:** `deploy-dev.yml` and `deploy-prod.yml` run `pnpm --filter
  @kortix/db migrate` before the EKS GitOps rollout. The disabled Helm PreSync
  hook is not the live migration path.

## Rules

1. Never edit a migration that has been applied anywhere. Write a new migration.
2. Never use `drizzle-kit push` or hand-apply production DDL outside the migration
   flow.
3. Review every generated SQL file before it reaches a shared DB.
4. Prefer expand/contract for destructive or compatibility-sensitive changes.
5. Prod is live: show the exact SQL and get explicit go-ahead before any manual
   prod migration action.

## Commands from repo root

| Command | What it does |
| --- | --- |
| `pnpm migrate` | Apply pending migrations using node-pg-migrate. |
| `pnpm migrate:status` | Dry-run/list pending migrations; exits non-zero if any are pending. |
| `pnpm migrate:create <slug>` | Create an empty hand-written SQL migration. |
| `pnpm migrate:generate <slug>` | Generate SQL from a `kortix.ts` schema change and update the Drizzle snapshot. |
| `pnpm migrate:fake` | Mark pending migrations as applied without running them (for baselining existing envs). |
| `pnpm migrate:lint` | Validate migration filename/order rules. |

## Safe schema-change loop

1. Edit `packages/db/src/schema/kortix.ts` for schema-shape changes, or create a
   hand-written migration for data/RLS/functions/grants/custom SQL.
2. Run `pnpm migrate:generate <slug>` or `pnpm migrate:create <slug>`.
3. Read the SQL top-to-bottom. Stop on accidental `DROP`, unsafe type changes,
   immediate `NOT NULL` on populated tables, or non-idempotent backfills.
4. Run `pnpm migrate:lint` and the relevant package tests/checks.
5. Apply to a local/throwaway DB before dev/prod when the change is non-trivial.
6. Commit both the migration SQL and any generated Drizzle snapshot changes.

See `packages/db/MIGRATIONS.md` for the full baseline, preview/prod behavior,
self-hosting command, and failure drill.
