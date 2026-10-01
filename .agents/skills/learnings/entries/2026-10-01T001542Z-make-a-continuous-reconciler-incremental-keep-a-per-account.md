---
recorded: 2026-10-01T00:15:42Z
incident_date: 2026-10-01
---
# Make a continuous reconciler incremental: keep a per-account high-water mark and never re-anti-join full history

**Rule:** A worker that loops over every account must read only rows newer than a persisted per-account high-water mark (plus a short lookback). Re-verify full history on a slow schedule (7 days), not on every visit. Never anti-join a source ledger against `kortix.audit_events` (142M rows) without that bound. Pin the per-row probe with `LEFT JOIN LATERAL ... LIMIT 1`, so a planner misestimate cannot hash-join the whole table.

**Trigger surface:** Writing or changing a background sweep, backfill, or reconciliation loop; adding a source ledger to `reconcileAuditEvents`; touching `audit-reconciliation-worker.ts`.

**Incident:** 2026-10-01 prod. The audit reconciliation query was the top `pg_stat_statements` entry: ~3.7M calls, 189-387 ms mean, 45-65k buffers per call, ~1.1M seconds total. It re-scanned the full history of 45,872 accounts on every replica, every cycle, and starved session create, /start, and gateway authorize (25 s deadline 503s). The fix is the high-water mark in `kortix.audit_reconciliation_state`. The drain poll on `session_lifecycle_commands` is not at fault: it ran in 2 ms read-only and slowed only because the DB was saturated.

**Enforcement:** `apps/api/src/shared/audit-reconciliation-incremental.integration.test.ts` (db-suites). It fails when a pass rescans reconciled history, loses rows after a partial pass, or skips the weekly full rescan.
