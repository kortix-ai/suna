---
recorded: 2026-10-08T22:41:31Z
incident_date: 2026-10-09
---
# Before a region switch, copy every bucket that holds records, not only the caches; the audit archive is the only copy of removed weeks

**Rule:** Before an environment's API moves region, list every bucket that
the API reads. Classify each one as a cache (the API rebuilds it) or a record
(no other copy exists). Copy every record bucket before the switch, keeping
each object's bytes, Object Lock mode, retain-until date and checksum. Then
prove the copy against the database. The audit archive is a record bucket.

**Trigger surface:** Moving a stack to another region or to another
`AUDIT_ARCHIVE_BUCKET`. Writing or following a switch-over runbook. Planning
the prod region move.

**Incident:** 2026-10-09, a near-miss on dev, found during the us-west-2
removal.
- **What went wrong:** the dev switch runbook said "Nothing below moves data"
  and treated every bucket as a cache. On 2026-10-06, dev started on
  `kortix-dev-use2-audit-archive`, which was empty. The 7 archived weeks
  (2026-04-13 to 2026-06-29: 445,598 rows, 622 objects) stayed in the us-west-2
  `kortix-dev-audit-archive`.
- **Why nobody saw it:** those weeks came from `audit_events_legacy`, and
  PostgreSQL still serves them. `retireLegacy` (`audit-archive/archive.ts`)
  drops that table once its newest row is 90 days old, and it does not check
  the bucket. After that drop, the account audit export reads those weeks from
  the empty bucket. 445,598 rows owed for 365 days would have become
  unreachable. The earliest drop date was about 2026-12-31.
- **Fix:** on 2026-10-09, all 622 objects were copied with their locks and
  checksums. All 7 weekly manifests match `manifest_sha256`. The procedure is
  in `infra/terraform/environments/dev-us-east-2/README.md`, Phase 4,
  "Data".

**Enforcement:** none yet. To build: before `retireLegacy` or
`removePartition` drops a week, it compares the week's manifest checksum in
the configured bucket with `manifest_sha256`, and it refuses the drop if they
differ.
