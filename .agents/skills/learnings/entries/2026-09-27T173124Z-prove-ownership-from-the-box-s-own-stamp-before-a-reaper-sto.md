---
recorded: 2026-09-27T17:31:24Z
incident_date: 2026-09-27
---
# Prove ownership from the box's own stamp before a reaper stops a provider box

**Rule:** A reaper that stops a provider box because its own database has no
row for it must first prove it owns the box from the box's stamp, on every
provider. The `kortix.env` tag is not ownership: deployed dev, every local
stack and every preview share one provider org and one tag, each with its own
database. A box is this instance's only when its `kortix.instance` stamp equals
this instance's `KORTIX_INSTANCE_ID`, and no id equals no stamp. A process with
no id on a loopback database reaps nothing. Stamp every box at create on every
provider.

**Trigger surface:** any code that lists provider boxes and then stops, archives
or deletes them (`reapOrphanProviderBoxes`, preview sweeps, fleet scripts); any
new provider adapter or `create()` path; any stack that runs the API with
`apps/api/.env` outside `scripts/dev-local.sh` or `pnpm worktree`.

**Incident:** 2026-09-27. A dev session turn ended with "The sandbox stopped
unexpectedly while this turn was running." Platinum's audit log attributed the
`sandbox.stop` to the laptop that ran the primary local stack. That checkout
predated #7569, whose rule treated an unstamped box as every instance's. The
local stack shared dev's Platinum and Daytona keys and `kortix.env=dev`, so each
5-minute maintenance pass stopped every deployed-dev box older than 60 min. Its
log held 59 stopping passes in 2 days, and 7 of 17 `runtime_gone` turns in 3
days ended within 4 min of one. Current `main` still had two holes: Daytona and
E2B had no instance check, and a deployed API stopped local stacks' stamped
boxes.

**Enforcement:** `providerBoxOwnedByThisInstance` and `orphanReapRefusal`
(`apps/api/src/projects/instance-scope.test.ts`); the reaper's ownership cases
(`sandbox-reaper.test.ts`, `ownership: a box is stopped only by the instance
that stamped it`); each provider reports and writes the stamp
(`platinum-list-managed.test.ts`, `daytona.test.ts`, `e2b.test.ts`). A stale
checkout still runs its old rule: update it to `main`, or set
`KORTIX_ORPHAN_BOX_REAP_ENABLED=false` in `apps/api/.env.local`.
