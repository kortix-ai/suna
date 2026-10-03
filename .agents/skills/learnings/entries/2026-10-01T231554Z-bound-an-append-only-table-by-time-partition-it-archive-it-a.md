---
recorded: 2026-10-01T23:15:54Z
incident_date: 2026-10-01
---
# Bound an append-only table by time: partition it, archive it, and never index it by a random key while it grows without limit

**Rule:** Give every append-only table a time bound before it has 10M rows: range-partition it by its event time, keep a fixed hot window, archive older partitions, and drop them. Never put a random-key index (UUIDv4, content hash, random revision) on a table without that bound: its working set grows with history, and ingest falls off the cache cliff. Use a time-ordered id (`kortix.uuid_v7()`) for new primary keys. A unique index on a partitioned table includes the partition key, so a dedupe key needs the event time in it.

**Trigger surface:** Adding a table that only grows (audit, usage, request logs, events); adding an index to `audit_events`; writing a migration that touches `audit_events`, `audit_webhook_deliveries` or any table a hot INSERT trigger writes to.

**Incident:** 2026-08-26 to 2026-10-01, prod. `kortix.audit_events` reached 145M rows and 210 GB with 11 indexes against a 4 GB `shared_buffers`. Three random-key indexes made each INSERT read cold pages (6 of 6 sampled INSERTs in `IO:DataFileRead`, 1.3 to 8.9 s), a per-session lock turned that latency into queueing, and the 10 s statement timeout became `POST .../audit/events` 503s, up to 188k a day. Five symptom fixes (lock convoy, dropped index, in-process mutex, detached trace write, noise cut) preceded the structural fix: UUIDv7 ids, no lock or hash chain, weekly partitions, 90-day hot window, S3 archive. Lock-order trap found while testing the cutover: an audit INSERT holds `audit_events` then needs `audit_webhook_deliveries` (the AFTER INSERT trigger), so a migration that locks the deliveries table first deadlocks (40P01) with live writers; lock `audit_events` first.

**Enforcement:** `packages/db/scripts/audit-events-partitioned.integration.test.ts` (partition layout, pruning, dedupe, default partition, no FK), `audit-events-partition-cutover.integration.test.ts` (swap on a database with history, prepared statements across the swap), `audit-events-uuid-v7.integration.test.ts`. Not yet automated: a CI check that a new table with `occurred_at` or `created_at` and no retention is flagged; build `tests/unit/append-only-tables-have-retention.test.ts` against an allowlist.
