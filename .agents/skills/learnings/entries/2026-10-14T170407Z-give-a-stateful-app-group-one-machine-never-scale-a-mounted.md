---
recorded: 2026-10-14T17:04:07Z
incident_date: 2026-10-14
---
# Give a stateful App group one machine; never scale a mounted group by adding volumes

**Rule:** A process group that mounts a volume runs one machine. Scale it up with the machine size (`kortix apps set --cpu/--memory-gb`, then deploy), never with `scale count`. Read every volume number from Platinum (`GET /v1/volumes/<v>`), never from the requested `initial_size_gb`: Platinum takes no size and allots a fixed class (100 GB) that cannot grow. Pin a snapshot only after `POST /v1/volumes/<v>/commit`, on the commit it returns.

**Trigger surface:** changing `apps/api/src/apps/fleet.ts` (`setAppScale`), `machines.ts` (`planMachines`, `reconcileAppMachines`), `volumes.ts` or `volume-store.ts`; telling a user how to scale or size a backend App (Convex, Postgres, SQLite).

**Incident:** 2026-10-14, a prod-readiness pass on a customer's Convex backend App (a near-miss, no data lost). On a dev drill App, `kortix apps scale count <app> 2` started a second machine on a new, empty volume, and reads through the one App URL alternated between two datasets. Writes routed to the second machine would have been cut off from the real data after a scale-down. Also found: the "50 GB" volume was a 98 GB ext4 device in the guest, `volumes extend` changed only a database column, and the daily tag pinned the implicit head rather than a fresh commit. Fixed on branch `apps-volume-safety`.

**Enforcement:** `apps/api/src/apps/machines.integration.test.ts` ("scale: a group with a volume runs one machine unless new_volumes …", "extend: a volume is the size the provider allots …") and `apps/api/src/apps/volume-store.test.ts` (commit before tag) in the `db-suites` and `core` lanes.
