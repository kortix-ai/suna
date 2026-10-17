---
recorded: 2026-10-14T21:22:26Z
incident_date: 2026-10-14
---
# Report repairing only when a repair will run, and request a daemon swap only after the tick's own convergence settles

**Rule:** A status that says "work in progress" (`starting`, `runtime_updating`) must ask the same skip predicate the worker uses (`bootstrapWouldSkip`); a repair that returns without touching the box is not a repair. A periodic pass that ends in a self-restart request runs after every gate it can collide with in the same tick has settled.

**Trigger surface:** Editing `guaranteeCurrentRuntimeOnOpen` (`apps/api/src/projects/lib/legacy-runtime-bootstrap-wiring.ts`), the bootstrap gates in `legacy-runtime-bootstrap.ts`, `runReconcileTick` (`apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-truth.ts`), or any agent-swap blocker.

**Incident:** 2026-10-14, dev. After 3 deploys that moved the daemon, idle boxes answered `POST /start` with `starting` / `runtime_updating` for 122 s, 390 s and 375 s. The open guarantee classified each box stale and scheduled the legacy repair. The repair returned `skipped-recent-check` without a log line: the reaper gives every running box a `current` check with a 6 h TTL, written before the deploy. The stall ended only when the daemon swapped itself, and the periodic tick refused that swap through the `config-convergence` blocker: the tick started the asset pass and the config convergence together, so the swap request raced the convergence and often lost (two local Platinum boxes: 2 of 3 requests refused). After the fix a box installed a newly published daemon 31 s after the manifest changed.

**Enforcement:** `legacy-runtime-bootstrap-wiring.test.ts` (a recent `current` check or a staged record answers `proceed` and schedules nothing; an expired check still repairs) and `runtime-truth.test.ts` ("the asset pass starts after the tick settles its convergence").
