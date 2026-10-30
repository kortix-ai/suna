---
recorded: 2026-10-29T20:41:46Z
incident_date: 2026-10-29
---
# Enable RLS and run ownership gates for every new kortix table

**Rule:** Declare `.enableRLS()` and enable row level security in the migration for every new `kortix` table. Leave client-role grants denied. Classify account transfer and session purge ownership explicitly before merging. Use a forward migration when the table already exists.

**Trigger surface:** Adding a table or a new account, project, or session reference to the Drizzle schema and migrations.

**Incident:** PR #11110 CI found six Artifact tables without RLS. Client-role privileges remained denied, but the defense-in-depth gate failed. The same CI run found unclassified transfer and purge references. Focused feature checks had missed these repository-wide ownership contracts.

**Enforcement:** `packages/db/src/schema/artifact-security.test.ts` verifies all six schema declarations. `integration-kortix-rls.test.ts` checks every migrated table and client-role grant. `projects/lib/project-transfer.integration.test.ts` and `integration-session-log-purge.test.ts` check ownership coverage. Run these through `pnpm test -- --db-only` with the individual file filters.
