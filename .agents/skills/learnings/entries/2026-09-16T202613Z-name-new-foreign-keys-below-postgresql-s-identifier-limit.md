---
recorded: 2026-09-16T20:26:13Z
commit: ca6d3bd509
---
# Name new foreign keys below PostgreSQL's identifier limit

**Near-miss (2026-09-16, PR #7319):** Drizzle generated a 70-byte foreign key
name for `session_provider_secret_pools`. PostgreSQL truncates identifiers at
63 bytes. The PR Squawk job rejected the migration before deploy.

**Rule:** give foreign keys on long table names an explicit short name in the
Drizzle schema. Keep the generated SQL and snapshot names identical. Run
`pnpm --filter @kortix/db lint:squawk` before pushing the migration.

**Enforcement:** the Squawk CI job rejects identifiers over 63 bytes. The
schema-sync job regenerates from `kortix.ts` and rejects snapshot drift.
