---
recorded: 2026-10-15T14:14:50Z
incident_date: 2026-10-15
---
# Guard a flow step that needs an unreachable provider on the local target; the release gate runs every flow against a real one

**Rule:** A REST flow under `tests/src/flows/` runs on the local profile in
`pnpm test` and against deployed staging in the release gate
(`pnpm test -- --target-full`). A step that asserts a state only an
unreachable provider produces (a removal that stays pending, a box that never
answers) holds only locally. Guard it with `ctx.env.target === 'local'` and keep
every assertion that holds on both targets unguarded. A green local run does
not prove a new flow passes the gate.

**Trigger surface:** Writing or reviewing a flow that seeds a fake sandbox row
(`createDatabaseSession`, an `external_id` that names no real box) and then
asserts on provider-side state.

**Incident:** 2026-10-15, release v0.13.58. `SESS-51` (new in #9792) asserted
`POST …/restore` → 409 `session_sandbox_removal_pending` because the local
provider cannot confirm the seeded box removed. On staging the provider
confirms it during the delete, so the restore answered 200, which is correct.
The gate (release PR #9951, run 38737177991) failed on attempts 2 and 3, and the
release took one extra staging round: hotfix #9953 into `staging`, the same
commit on `dev` as #9954, a staging redeploy and a re-dispatched Promote.

**Enforcement:** None automatic. The release gate is the first run of a flow
against a deployed provider. Review a new flow for local-only provider
assumptions before the merge into `dev`.
