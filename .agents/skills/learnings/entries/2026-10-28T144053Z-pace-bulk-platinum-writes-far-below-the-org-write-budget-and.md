---
recorded: 2026-10-28T14:40:53Z
incident_date: 2026-10-28
---
# Pace bulk Platinum writes far below the org write budget and honor 429 retry-after: every prod box shares that budget

**Rule:** A loop that sends many Platinum writes (account erasure, sweeps, backfills) runs at most a few writes per second, sleeps for `retry-after` on a `429`, and never re-sends a write for a box it already proved gone. Platinum limits writes per org (`org_mutation`, 20/s sustained). Every prod box create, start, `expose` and stop draws from that same budget.

**Trigger surface:** Account erasure (`deleteAccountExternalStores`, `reclaimAccountSandboxes`), any script or worker that loops `provider.remove`/`stop` over many boxes, and any rerun of such a loop after a partial failure.

**Incident:** 2026-10-28, prod v0.14.8. An operator erased a churned enterprise account with about 17,000 parked boxes through `deleteAccountImmediately` in a one-off ECS task. The first run (8 removes in parallel) left 124 boxes on Platinum timeouts and `503`s, and the routine threw as designed. The rerun sent `DELETE` again for every box. Boxes that were already gone answered at once, so the rerun reached the org write budget in seconds: about 400 `429`s in 3 min. One user session's `POST /v1/sandboxes/<sbx>/expose` got a `429` (its `/start` still returned `200` in 6 s). The operator stopped the task and finished at under 2 writes/s, checking each box with `GET` first: 0 `429`s across 17,467 boxes.

**Enforcement:** none yet. To build: a shared write limiter on the Platinum provider's `remove`/`stop` path that sleeps for `retry-after`; and an erasure retry that skips a box whose removal was already confirmed. Each gets a unit test with a fake clock that asserts the pacing and the skip.
