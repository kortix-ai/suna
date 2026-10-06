---
recorded: 2026-10-06T13:17:37Z
incident_date: 2026-10-05
supersedes: 2026-10-04T225403Z-rotate-the-web-gate-password-in-every-blob-the-deploy-verifi.md
---
# Verify an environment's web gate with that environment's own blob; a blob another branch deploys lags every rotation

**Rule:** a deploy check reads the gate password from the blob of the host it
checks. Deploy Dev reads `kortix-dev-web-env`, which `deploy-web-ecs` syncs
from the same commit's `apps/web/.env.dev`. Never read `kortix-staging-web-env`
for dev: Deploy Staging rewrites it from the `staging` branch.

**Trigger surface:** adding or editing a `WEB_PROTECTION_PASSWORD=<blob>:...`
read in a workflow, or rotating the web gate password on `main`.

**Incident:** #9151 rotated the password on `main` (2026-10-04). `staging` did
not get it until `4185b00bdb` (2026-10-06 11:00Z). Each Deploy Staging in
between wrote the old value back to the staging blob, which undid the manual
fix from the superseded entry. Deploy Dev then failed "Verify canonical Dev
frontend on ECS" with `protected=401` 160 times on 5 runs (2026-10-05 21:38Z
to 2026-10-06 10:39Z), although dev served the right commit. 6 PRs got "Not
live on dev yet", and no later run edits it: the next run's base is the API
commit, which had already moved past them.

**Enforcement:** `tests/unit/web-ecs-workflow.test.ts` requires
`kortix-dev-web-env` in the `verify-web-dev` job and rejects
`kortix-staging-web-env` there.
