---
recorded: 2026-08-19T18:23:07Z
incident_date: 2026-08-19
commit: 53c1940195
---
# A VALIDATE ships only with a reconciliation the TARGET data has passed

**When:** writing `VALIDATE CONSTRAINT` for an FK/CHECK added `NOT VALID`.
Zero violating rows on the local DB is not evidence — local data is young.
Long-lived envs hold rows written before the catalog/constraint existed (dev:
`iam_role_actions` rows with retired `project.cr.*`/`trigger.*` actions).
Either probe every target env for violators first, or — better — precede the
VALIDATE with idempotent reconciliation DML in the same migration so it cannot
fail on data the constraint predates. Reconcile by REMAPPING a retired value to
its replacement, never by deleting the row: where the retired action was a
rename/collapse (`project.cr.open` -> `project.gitops.push`), the row is the
whole reason the old name still exists, and deleting it silently strips a
capability from whoever held it — a permission change disguised as a migration
fix. Delete only a value with no replacement (the dead `trigger.*` family). A merged migration that VALIDATE-fails
blocks EVERY deploy of that env; the only sanctioned fix is a checksum-guarded
runtime override (`packages/db/scripts/migration-runtime-overrides.ts`).
*Incident:* RBAC cutover #6594 — `role_permissions_action_permissions_fk`
VALIDATE 23503'd on dev; Deploy Dev blocked ~1h; fixed by the third runtime
override (map `cr.*`→`gitops.*` dedup-aware, purge uncataloged, then VALIDATE).
*Enforcer:* `migration-runtime-overrides.test.ts` pins the override; nothing
yet lints "VALIDATE without reconciliation" — prose only.
