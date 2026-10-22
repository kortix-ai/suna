---
recorded: 2026-10-11T01:56:01Z
incident_date: 2026-10-11
---
# When a package the API image copies piecemeal gains a workspace dependency, copy its node_modules into the runtime stage

**Rule:** The API runtime stage (`apps/api/Dockerfile`) copies some workspace packages piecemeal (`src`, `package.json`, `tsconfig.json`). When such a package's `package.json` lists a `workspace:` dependency that its code imports at runtime, also copy `packages/<name>/node_modules`. That directory holds the link to the dependency. The local workspace resolves the import through hoisting, so every local test passes.

**Trigger surface:** Adding a runtime import from one workspace package to another (`@kortix/shared`, `@kortix/llm-catalog`, …) in a package that the API image copies piecemeal: `manifest-schema`, `starter`, `registry`, `db`, `agent-tunnel` or `api-contract`.

**Incident:** 2026-10-11, PR #9527. `manifest-schema` gained `import … from '@kortix/shared/app-config'`. The dev Deploy API job failed: new tasks exited at boot with `Cannot find module '@kortix/shared/app-config' from '/app/packages/manifest-schema/src/index.ts'`, reproduced by pulling the pushed `kortix/kortix-api` digest. The ECS circuit breaker rolled back, so dev kept serving the previous API. Blast radius: one failed dev deploy, and the merged change was not live for about 1 h. The same class hit the SDK's `@kortix/llm-catalog` link earlier.

**Enforcement:** `apps/api/src/__tests__/unit-api-dockerfile-runtime-artifacts.test.ts`, the test "a package copied piecemeal keeps the node_modules links to its workspace dependencies" (`pnpm test`, `packages` lane). It parses the runtime stage, and every piecemeal package with a `workspace:` dependency must copy its `node_modules`.
