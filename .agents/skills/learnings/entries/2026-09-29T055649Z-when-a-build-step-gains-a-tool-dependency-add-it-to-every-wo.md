---
recorded: 2026-09-29T05:56:49Z
incident_date: 2026-09-29
---
# When a build step gains a tool dependency, add it to every workflow that builds that artifact

**Rule:** When a build script starts needing a new tool (bun, a binary, a workspace package), grep `.github/workflows/` for every job that runs that script or builds that artifact and add the setup step to each one in the same PR. Local and PR-time runs do not execute those jobs.

**Trigger surface:** `apps/desktop-electron/scripts/ensure-runtime.js`, `electron-builder.yml` `extraResources`, any `scripts/*` a workflow calls; `ci.yml`, `desktop.yml`, `deploy-prod.yml`.

**Incident:** 2026-09-29, PR #8168 made ensure-runtime.js build the bundled computer agent with bun and added setup-bun to `desktop.yml` and `deploy-prod.yml` but not to `ci.yml`'s Desktop installer smoke: `spawnSync bun ENOENT` on the merge commit; `main` red until PR #8170.

**Enforcement:** `tests/unit/desktop-build-bun.test.ts` fails for any workflow job that runs `ensure-runtime.js` or `electron-builder` without `oven-sh/setup-bun` (proven by removing it from `ci.yml`).
