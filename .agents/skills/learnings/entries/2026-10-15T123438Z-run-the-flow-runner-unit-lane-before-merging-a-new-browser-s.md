---
recorded: 2026-10-15T12:34:38Z
incident_date: 2026-10-15
---
# Run the flow-runner-unit lane before merging a new browser spec

**Rule:** A new file under `tests/e2e/specs/` needs a row in
`tests/e2e/shard-durations.json`, in both the `local` and the `deployed` table.
Before merging a branch that adds a browser spec, run the `flow-runner-unit` lane
(`pnpm --dir tests test:unit`). Running only the new journey and its flows does
not run the guard. Run the lane with vitest, through that script: under a bare
`bun test tests/unit` the same files report about 140 unrelated failures.

**Trigger surface:** Adding or renaming a Playwright journey in
`tests/e2e/specs/`, and verifying a branch with `pnpm test -- --id <flows>` or
`E2E_GREP` only.

**Incident:** 2026-10-15, PR #9942 added `52-session-pin-archive.spec.ts`
without a shard row. The branch ran its flows, journey 52 and the package
suites, but not `flow-runner-unit`. A pull request into `dev` runs no CI, so the
merge was the first run of the guard: the `core` lane went red on `dev` (Tests run
38723566860), which blocks the next promotion. PR #9950 added the row. The next
branch with a new journey (PR #9949, journey 53) added its row before the merge.

**Enforcement:** `tests/unit/browser-shard.test.ts` "every spec file on disk is
in the table" goes red in the `flow-runner-unit` lane of `pnpm test`, and on every
push to `dev`. Nothing runs it before a merge into `dev`: that run is the author's.
