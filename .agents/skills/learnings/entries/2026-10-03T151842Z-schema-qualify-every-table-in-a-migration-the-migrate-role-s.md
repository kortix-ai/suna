---
recorded: 2026-10-03T15:18:42Z
incident_date: 2026-10-03
---
# Schema-qualify every table in a migration; the migrate role's search_path differs per environment

**Rule:** Write `schema.table` for every relation and type in a migration, including inside policy bodies and `DO` blocks. `scripts/migrate.ts` passes no `schema` to node-pg-migrate, so each database resolves bare names with its role's default `search_path`. Before promoting, run each pending plain `.sql` migration inside `begin; … rollback;` against dev AND staging with the real `DATABASE_URL`. A static read misses name resolution.

**Trigger surface:** writing or reviewing a migration that names a table without a schema, especially the legacy `public.*` tables whose names also exist in `kortix.*` (`projects`, `threads`).

**Incident:** 2026-10-03, v0.13.48 promotion. `message_select_policy_initplan` recreated a `public.messages` policy with bare `threads` and `projects`. Dev's role has `search_path = kortix, public, extensions`, so `projects` resolved to `kortix.projects`, and the apply failed with `column projects.is_public does not exist`. Staging and prod use `"$user", public, extensions`, where the same file passes. Every Deploy Dev run halted at the migration step until the file was removed. A static costing pass against prod had marked it SAFE.

**Enforcement:** none yet. To build: a `lint-migrations.ts` rule that rejects an unqualified relation after `FROM`, `JOIN`, `ON`, or `UPDATE` in a new migration.
