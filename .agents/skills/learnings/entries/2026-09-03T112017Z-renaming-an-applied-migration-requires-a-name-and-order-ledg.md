---
recorded: 2026-09-03T11:20:17Z
incident_date: 2026-09-03
commit: ca596ff7bb
---
# Renaming an applied migration requires a name-and-order ledger repair

- **Incident (2026-09-03, `pi-worker` preview):** two Pi migrations initially
  used timestamps before migrations already merged into `main`. Moving the Pi
  files after the merged migrations fixed fresh and sequential migration gates.
  The persistent preview database still recorded the old names and their old
  `run_on` order. `node-pg-migrate` rejected startup before the API bound port
  `8080`, and the preview hostname returned `502` during the failed cutover. A
  first repair tried to interpolate the renamed rows between adjacent `run_on`
  values. PostgreSQL preserved sub-millisecond precision, but the Node `Date`
  conversion collapsed both bounds to the same millisecond and rejected the
  second preview deployment.
- **Rule:** never rename an applied migration without a checksum-guarded ledger
  repair. The repair must update both `name` and `run_on` when the rename crosses
  other applied migrations. A fresh database cannot prove this upgrade path.
- **Enforcement:** `migration-ledger-repair.test.ts` pins both Pi name mappings.
  `migration-ledger-repair.integration.test.ts` builds a historical ledger with
  identical sub-millisecond timestamps, runs the locked repair, and requires
  strict `node-pg-migrate` order to report no pending migrations. The repair
  normalizes the affected ledger suffix inside PostgreSQL at microsecond
  precision; it never round-trips ordering bounds through JavaScript.
