---
recorded: 2026-10-07T07:24:39Z
incident_date: 2026-10-07
---
# Restore real timers in afterEach of every bun test that fakes them

**Rule:** A bun test file that calls `jest.useFakeTimers()` calls `jest.useRealTimers()` in an `afterEach`. Fake timers are process-wide in bun: `--isolate` gives each file a fresh global object, not a fresh clock.

**Trigger surface:** Writing or reviewing a bun test that fakes timers or the system clock (`jest.useFakeTimers`, `setSystemTime`).

**Incident:** 2026-10-07. #9222 (07:44) added two `jest.useFakeTimers()` tests to `apps/web/src/lib/chunk-reload.test.ts` with no restore. The next file in the same worker, `src/lib/auth/sign-out-sequence.test.ts`, waited on a real `setTimeout` forever. The `apps/web` suite stalled at 0% CPU, so every branch's local `pnpm test` packages lane hung and no attestation could go green until the fix. Found by bisecting `src/lib` in one `bun test --isolate` process down to that pair.

**Enforcement:** `tests/unit/fake-timers-restored.test.ts` (core lane) fails when a tracked `*.test.ts(x)` calls `useFakeTimers(` without `useRealTimers(`.
