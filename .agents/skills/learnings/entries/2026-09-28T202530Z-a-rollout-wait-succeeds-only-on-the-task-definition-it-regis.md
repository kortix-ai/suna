---
recorded: 2026-09-28T20:25:30Z
incident_date: 2026-09-28
---
# A rollout wait succeeds only on the task definition it registered; a rollback to the old revision fails the deploy

**Rule:** An ECS rollout wait returns success only when the task definition this roll registered is the PRIMARY deployment and runs every task. A PRIMARY on any other revision, or a FAILED deployment of the registered one, fails the job at once with the stopped-task reasons of the registered revision. Never judge a roll by "the PRIMARY deployment is COMPLETED": a circuit-breaker rollback is a PRIMARY deployment that completes.

**Trigger surface:** Editing `infra/scripts/ecs-deploy.sh` or any wait on an ECS/EKS roll in `deploy-dev.yml`, `deploy-prod.yml`, or a new deploy workflow; adding a job gated on `deploy-api-ecs` success (for example the `:dev` channel retag).

**Incident:** 2026-09-28, dev. PR #7981 made the SDK import `@kortix/llm-catalog/lite` at runtime; the API image lacked the link, so every new API task exited `1` (fixed by PR #8014). ECS rolled back to the old revision. Five Deploy Dev runs (revisions 1141 to 1144) printed "rollout SERVING ... on" the old revision and passed. dev-api served one commit for ~2 h, and the `:dev` self-host tag moved onto the crashing images. PR #8018 fixes the wait.

**Enforcement:** `tests/unit/ecs-stabilize-budget.test.ts` "only the registered revision counts" (a rollback, with and without the failed deployment listed, in `serving` and `stable`, exits 1 with the new revision's stopped reason). The image-content cause: `apps/api/src/__tests__/unit-api-dockerfile-runtime-artifacts.test.ts` (PR #8014). None yet: a boot smoke of the built API image in `build-api` before the ECS roll.
