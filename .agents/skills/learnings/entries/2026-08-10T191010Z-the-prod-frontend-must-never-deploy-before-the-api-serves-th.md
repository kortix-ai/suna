---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# The prod frontend must never deploy before the API serves the release

**When:** touching `vercel.json`, `vercel-ignore.sh`, or `deploy-prod.yml`.
A push to `prod` must not auto-deploy kortix.com; the frontend deploys only from
deploy-prod's `deploy-web-vercel` job after `verify-live-version` proves the API
is on the release. A new frontend against an old API calls routes that do not
exist — every project load fails "before we could check your access".
*Incident:* v0.12.7 — Vercel auto-promoted the new frontend while the API stayed
back after its migration failed; second occurrence of the class (v0.10).
*Enforcer:* `deploymentEnabled.prod:false` + `deploy-web-vercel` job, pinned by
`tests/unit/web-ecs-workflow.test.ts`.
