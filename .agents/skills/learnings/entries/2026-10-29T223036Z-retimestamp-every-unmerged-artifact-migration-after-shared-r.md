---
recorded: 2026-10-29T22:30:36Z
incident_date: 2026-10-29
---
# Retimestamp every unmerged Artifact migration after shared RLS and rechain its snapshots

**Rule:** After merging dev, move every unmerged Artifact migration after the newest shared migration. Preserve each SQL/TypeScript byte. Rechain branch snapshots after the shared tail and preserve its RLS flags. Keep shared applied migrations and ledgers unchanged; recreate owned disposable databases after fixture cleanup.

**Trigger surface:** Updating the Artifact comments branch after dev applies a newer migration.

**Incident:** PR #11110 added nine branch migrations before dev applied its Artifact RLS migration. Leaving their older timestamps would block Deploy Dev. The branch snapshots also preceded the new RLS snapshot. This was caught before merge.

**Enforcement:** `scripts/check-migration-order.sh`, `pnpm --filter @kortix/db lint`, Drizzle check/schema-sync, and the fresh isolated RLS/transfer/purge DB suites. The repair preserves nine SHA-256 values and passes 54 DB tests.
