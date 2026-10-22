---
recorded: 2026-10-12T01:07:56Z
incident_date: 2026-10-11
---
# Apply each prod migration in its own transaction; a pending backlog in one transaction deadlocks against live traffic

**Rule:** `migrate.ts up` runs one transaction per migration file (`RUNNER_TRANSACTION_MODE` in `packages/db/scripts/migration-target.ts`). Never switch it back to `singleTransaction: true`. When a release carries a migration backlog against a hot table and the deploy's migrate job deadlocks, do not rerun the same batch: apply the pending files per file (the same runner, the release's exact tree) and rerun the deploy.

**Trigger surface:** Changing `packages/db/scripts/migrate.ts` or its runner options; a `Deploy Prod` whose `Apply DB migrations to prod` job fails with `deadlock detected`; any release that carries more than a handful of migrations.

**Incident:** 2026-10-11 21:01Z, `Deploy Prod` for v0.13.54 (run 38174470730). Prod was 43 migrations behind. node-pg-migrate committed at each `.concurrent` file, then ran the next ~25 plain files as one transaction; at `CREATE TRIGGER ... AFTER DELETE ON kortix.project_sessions` (`ephemeral_sessions`) it deadlocked with live traffic, 3 of 3 attempts. The deploy stopped after npm publish and image retag, so prod kept serving 0.13.53 on a schema with 14 of 43 migrations applied, and the non-dismissible "Release in progress" banner stayed up for ~4 h because only a green rollout lowers it. The remaining 30 files then applied per file with 0 deadlocks (2026-10-12 ~01:10Z).

**Enforcement:** `packages/db/scripts/migration-transaction-mode.integration.test.ts` (db-suites, real PostgreSQL): of two pending files the second fails, and the first must stay applied; with `singleTransaction: true` it fails. None yet for the stuck banner: a failed `Deploy Prod` does not lower it (`maintenance-banner-off` needs a green rollout).
