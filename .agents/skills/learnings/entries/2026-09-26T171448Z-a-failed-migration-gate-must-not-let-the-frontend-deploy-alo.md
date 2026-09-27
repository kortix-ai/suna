---
recorded: 2026-09-26T17:14:48Z
incident_date: 2026-08-19
---
# A failed migration gate must not let the frontend deploy alone

**Rule:** In `deploy-dev.yml`, `deploy-api-ecs` needs `migrate-db` — a failed
migration blocks the API rollout. `deploy-web-ecs` does not need `migrate-db`
and never has. A migration failure therefore still yields a HALF-deployed
environment: new web bundle, old API image. A `/health` 200 on either surface
proves nothing about the other. When verifying that a merge reached dev,
check BOTH `dev-api.kortix.com/v1/health` and `dev.kortix.com` against the
merge commit — `git merge-base --is-ancestor <merge-sha> <deployed-sha>` —
never by eyeballing one version string. Read the job list, not the run
conclusion: `Deploy API to dev (ECS Fargate): skipped` beside a green `Build
API image` is the tell that migrations failed and blocked only the API half.

**Trigger surface:** verifying that a merge reached dev or staging; touching
`deploy-dev.yml`'s job dependency graph; investigating a "some routes 404,
others work" report right after a deploy.

**Incident:** 2026-08-19 — #6594's `rbac_cutover_views` migration failed its
`VALIDATE CONSTRAINT` step on dev (workflow runs 32278453790, 32281594823),
which blocked `deploy-api-ecs` via the `migrate-db` dependency but did not
block `deploy-web-ecs`, which has no such dependency. Dev ran a split
API/web pair for roughly 40 minutes; every merge that landed in that window
was stranded behind the old API image while the new frontend called routes
the old API did not yet serve.

**Enforcement:** none yet — verified 2026-09-26 against `deploy-dev.yml` on
`main`: `deploy-api-ecs`'s `needs:` still includes `migrate-db`;
`deploy-web-ecs`'s `needs:` still does not. The two-surface ancestry check
above is prose, not a gate. Build it into the deploy workflow's own verify
step, or add a `deploy-web-ecs` dependency on `migrate-db` succeeding.
