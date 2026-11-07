---
recorded: 2026-11-07T06:01:20Z
incident_date: 2026-11-07
---
# Exclude colocated test files from every Docker build context with **/*.test.ts

**Rule:** In `.dockerignore`, write test patterns as `**/*.test.ts`. Docker matches a bare `*.test.ts` at the context root only, so a test colocated in `src/` enters the image and its typecheck.

**Trigger surface:** adding a test next to source code in a package an image builds (kortixd, the API, the gateway), especially one that imports a file outside the package by a relative path.

**Incident:** 2026-11-07, the dev deploy of #11857. `apps/kortix-sandbox-agent-server/src/lib/kortix-api/workspace-routes.test.ts` imports `packages/shared/src/workspace-routes` by a relative path. The kortixd build stage of `apps/api/Dockerfile` copies 2 files of `packages/shared`, so `bun run typecheck` in `scripts/build.sh` failed with TS2307 and the API image did not build. All CI lanes were green: they run outside Docker.

**Enforcement:** the `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/*.spec.tsx` lines in the root `.dockerignore`. A production file that imports an uncopied path still fails the image build; `src/__tests__/shared-sources.test.ts` covers that for kortixd.
