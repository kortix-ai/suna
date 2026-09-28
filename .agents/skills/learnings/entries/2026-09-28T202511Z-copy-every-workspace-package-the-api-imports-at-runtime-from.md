---
recorded: 2026-09-28T20:25:11Z
incident_date: 2026-09-28
---
# Copy every workspace package the API imports at runtime from the deps stage, with its node_modules

**Rule:** When a package the API runs starts importing another workspace
package at runtime, the API image must carry that package's own
`node_modules` link. Copy it with `COPY --from=deps /app/packages/<pkg>`,
never from the build context, which `.dockerignore` strips of `node_modules`.

**Trigger surface:** Adding a runtime (non-type) import of `@kortix/*` to
`packages/sdk`, `packages/shared`, or any package `apps/api` loads, or
editing the runtime stage of `apps/api/Dockerfile`.

**Incident:** 2026-09-28, dev. #7981 made the SDK import
`@kortix/llm-catalog/lite`. The runtime stage copied `packages/sdk` from
the build context, so every new dev API task exited 1 with "Cannot find module
'@kortix/llm-catalog/lite'". ECS kept the old task definition. Dev-api served
`e8d27eb33e` from 18:17Z to about 20:13Z, while 3 deploys ran. The deploy
step printed "rollout SERVING" against the old task definition; only the
Live-on-dev comment reported it. Fixed by #8014.

**Enforcement:** `apps/api/src/__tests__/unit-api-dockerfile-runtime-artifacts.test.ts`
asserts the runtime SDK copy comes from `deps`. The general case (any new
runtime import) has none yet: a post-build smoke that runs
`bun -e "await import('./src/index.ts')"` inside the built image would catch
every package. `infra/scripts/ecs-deploy.sh --wait-for serving` should
also require the NEW task definition.
