---
recorded: 2026-08-19T16:38:33Z
incident_date: 2026-08-19
commit: 1addb77a0c
---
# `ON CONFLICT (cols)` cannot run against a view

**When:** replacing a table with a compatibility view (expand/contract), or
adding an INSTEAD OF trigger.
A view has no indexes, so `INSERT ... ON CONFLICT (a, b) DO UPDATE` fails at
runtime with `42P10 there is no unique or exclusion constraint matching the ON
CONFLICT specification` — INSTEAD OF triggers do not help, because inference
happens before they run. `ON CONFLICT DO NOTHING` with NO target does work. A
view with a JOIN is not auto-updatable at all, and a rendered/expression column
is never assignable even on an otherwise auto-updatable view.
The rule: **before turning a table into a view, grep every writer for
`onConflictDoUpdate` / `ON CONFLICT (` on that relation and rewire it first.**
*Near-miss:* the canonical-RBAC cutover — five production write sites on
`project_members` / `project_group_grants` / `iam_resource_grants` / the
`account_members` accept paths would have 500'd on the first grant after deploy.
*Enforcer:* `apps/api/src/__tests__/unit-iam-gate-codemod-pin.test.ts`
("no production module writes a legacy grant table directly").
