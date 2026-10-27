---
recorded: 2026-10-11T23:50:59Z
incident_date: 2026-10-12
---
# A silent 100% CPU `bun test --isolate` worker is a lost spawnSync child exit; CI and local Bun stay on 1.4.3 or later

**Rule:** Run the repo on Bun 1.4.3 or later. Bun 1.3.14 can lose a child's exit inside `spawnSync`, `execSync` or `execFileSync` and spin the calling thread at 100% CPU forever. A `--test-worker` with no output, no live child and ~98% CPU is this bug until proven otherwise: kill only that worker (`kill <pid>`), read the `worker crashed` file name, and move that file's child spawns to async `Bun.spawn` with a `timeout`.

**Trigger surface:** running `pnpm test` (packages lane: `apps/web`, `apps/cli`) or any `bun test --isolate --parallel=N` suite; adding `spawnSync`, `execSync` or `execFileSync` to a `*.test.*` file (127 files had them on 2026-10-12).

**Incident:** 2026-10-11 and 2026-10-12, one Mac, Bun 1.3.14. Three `bun test --test-worker` processes spun for 10 to 25+ minutes with no output and no child process: `apps/web/src/lib/navigation/nav-contract.test.ts`, `apps/cli/src/tui-bin.test.ts`, `apps/web/scripts/build-content-timestamps.test.mjs`. `sample <pid>` showed the main thread in a loop of `kevent64` calls. The lane stopped only after a manual kill, which printed `worker crashed: SIGTERM`. Upstream: oven-sh/bun#34069, fixed by oven-sh/bun#44581, contained in Bun 1.4.3. Measured A/B, 16 suite runs per version: 1 hang on 1.3.14, 0 on 1.4.3. A stress of 3 runs x 8 processes (~800k `spawnSync`/`execFileSync` calls) per version did not reproduce it on either, so the trigger needs the `--isolate` worker context. A different `--isolate` main-thread spin is open upstream as oven-sh/bun#44898; 1.4.3 did not show it in 16 runs.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` pins `bun-version: 1.4.3` in `tests.yml`, and `apps/api/src/__tests__/unit-runtime-versions.test.ts` pins the sandbox image tag. None yet for the hang itself: the enforcer to build is a watchdog in `tests/bin/package-quality.ts` that fails the lane naming the file when a `--test-worker` burns CPU with no output for N seconds.
