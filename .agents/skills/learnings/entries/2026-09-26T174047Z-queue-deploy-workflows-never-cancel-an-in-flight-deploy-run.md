---
recorded: 2026-09-26T17:40:47Z
incident_date: 2026-09-26
supersedes: 2026-08-11T063009Z-a-deploy-workflow-must-not-cancel-a-build-it-cannot-outrun.md
---
# Queue deploy workflows; never cancel an in-flight deploy run

**Rule:** Every `.github/workflows/deploy-*.yml` sets `cancel-in-progress: false`. GitHub keeps one running and one pending run per group, and a newer pending run replaces the older one, so a burst still deploys only the newest commit. A cancel restarts the whole pipeline on every push and can kill `migrate-db` mid-run. "The build is fast now" is not a reason to cancel: pushes arrive faster than any deploy.

**Trigger surface:** Editing `concurrency:` in a deploy workflow, or trying to make dev "converge faster".

**Incident:** 2026-08-10 (3.5 h stale dev API) produced the 2026-08-11 rule without an enforcer. `d8847d39ba` flipped Deploy Dev back to `true` on 2026-08-20. 2026-09-19..26: 90 of 235 Deploy Dev runs cancelled, merge -> live p90 28.8 min, max 49.8 min. Fixed in #7763, which also queues deploy-staging (it ran `migrate-db` under `true`).

**Enforcement:** `tests/unit/deploy-concurrency.test.ts` fails on any `cancel-in-progress: true` in a `deploy-*.yml`.
