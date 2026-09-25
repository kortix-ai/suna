---
recorded: 2026-09-21T17:00:39Z
incident_date: 2026-09-21
commit: dd52f56ca6
---
# A CI step that creates shared state must be torn down on EVERY lane that creates it

**Rule:** When a CI step starts a service that binds host ports, its teardown
runs `if: always()` on every lane that can start it — not only the lane whose
name suggests it — and a matching pre-run sweep removes anything still holding
those ports by port number, because `supabase stop` reaches only containers of
its own project name. **Trigger surface:** editing `.github/workflows/tests.yml`
or any workflow that runs `supabase start` / `docker run -p`. **Incident:** four
runs failed on 2026-09-21 across the `core`, `packages` and `browser` lanes with
`failed to bind host port for 0.0.0.0:54324: address already in use`. "Stop the
local Supabase stack" was gated `if: always() && matrix.mode == 'browser'`, but
`core` and `packages` start Supabase too through `pnpm test`, so a reused
Blacksmith runner kept 54321-54324. Each failure read as a test failure, not as
infrastructure. **Enforcers:** the "Free the local Supabase ports" step in
`tests.yml`, plus `tests/unit/sandbox-workflow.test.ts` and
`apps/api/src/__tests__/unit-ci-api-suite-runs.test.ts`, which now assert the
teardown is ungated and slice the step by its `- name:` (a whole-file
`toContain('if: always()')` matched the artifact upload and proved nothing).

**Second rule from the same fix:** a workflow edit is never a one-file change.
`.github/workflows/tests.yml` is asserted on as a string by four test files in
three packages (`tests/unit/sandbox-workflow.test.ts`,
`tests/unit/web-ecs-workflow.test.ts`,
`apps/api/src/__tests__/unit-ci-api-suite-runs.test.ts`,
`apps/web/src/test-report-artifact.test.ts`) that fail in different lanes. Find
them all before pushing:
`grep -rln "workflows/tests.yml" --include='*.ts' . | grep -v node_modules`.
Fixing only the first cost two full CI round trips.
