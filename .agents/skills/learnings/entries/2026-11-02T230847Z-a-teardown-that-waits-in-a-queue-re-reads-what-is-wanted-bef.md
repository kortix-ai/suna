---
recorded: 2026-11-02T23:08:47Z
incident_date: 2026-11-02
---
# A teardown that waits in a queue re-reads what is wanted before it deletes

**Rule:** A destructive job that can wait in a concurrency group reads the current state when it starts, not the event that queued it. The `teardown` job of `deploy-preview.yml` reads the pull request's labels first and stops when `preview` is back.

**Trigger surface:** `.github/workflows/deploy-preview.yml` (`teardown`, any job in the `deploy-preview-<pr>` concurrency group), and anyone who removes and re-adds the `preview` label to rebuild images.

**Incident:** 2026-11-02, PR #11510. Removing and re-adding `preview` queued the `unlabeled` run (41524587960) behind the `labeled` run. Cancelling the labeled run after its image publish released the teardown 33 min later, and it deleted a live branch environment with its database. One environment and one latency run lost. No production impact.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` ("preview teardown"): the label read runs before every other step, and every later step carries its `if`.
