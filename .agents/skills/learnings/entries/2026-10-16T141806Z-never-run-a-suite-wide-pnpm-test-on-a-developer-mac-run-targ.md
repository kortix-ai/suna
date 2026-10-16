---
recorded: 2026-10-16T14:18:06Z
incident_date: 2026-10-16
---
# Never run a suite-wide pnpm test on a developer Mac; run targeted tests and leave the suite to CI

**Rule:** On macOS, run one flow (`pnpm test -- --id <ID>`), one DB suite path (`--db-only <filter>`), the SDK (`--sdk-only`), or one package's test file. The whole suite (plain `pnpm test`, `--full`, `--packages-only`, `--browser-only`, unfiltered `--db-only`) runs in CI or on a Linux box. `KORTIX_FULL_TEST=1` overrides only when a person asks.

**Trigger surface:** An agent session or a person verifies a change before a merge into `dev` on a laptop.

**Incident:** 2026-10-16. Five agent worktree sessions ran `pnpm test` on one laptop at the same time, 21–43 min each. Load average reached 112 and swap 16.5 of 17.4 GB. The laptop was unusable for interactive work. Each run alone takes ~8 min; five in parallel starved each other.

**Enforcement:** `refusesSuiteRun` in `tests/src/core/local-runner.ts` makes `pnpm test` exit `2` on darwin for a suite-wide mode. `tests/unit/local-runner.test.ts` "refuses a suite-wide run on a Mac" pins the modes.
