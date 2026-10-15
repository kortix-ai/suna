---
recorded: 2026-10-15T15:10:54Z
incident_date: 2026-10-15
---
# Run the whole unit script of a package whose source you change, not a subset

**Rule:** A change to a package's source runs that package's whole unit
script before the merge: `cd apps/api && bash scripts/test.sh`, `bun test
--isolate` in `apps/web` or `apps/mobile`. Other test files pin the code you
change from far away: a hand-built db mock answers only the query chain it
knew, and a source-text guard counts call sites. Neither is in the "related"
subset you would pick by name.

**Trigger surface:** Changing a query's shape (a new `leftJoin`, a new column),
adding a call to a guarded helper (`sessionIsTombstoned`, `assertAgentScope`),
or verifying a branch with a hand-picked list of test files.

**Incident:** 2026-10-15, PR #9949 (KRTX-2419). `resolveSessionHarness` started
reading the project `LEFT JOIN` its session row, and the `/recover` route added
a third `sessionIsTombstoned(visible.row)`. The branch ran a 22-file subset of
the API unit tests (222 pass). The merge turned 7 tests in 2 files red: the
db mock in `unit-trigger-fire-paths.test.ts` had no `leftJoin` (6 tests), and
`access.test.ts` counted 2 tombstone calls. The `packages` lane on `dev` went
red, which blocks every attestation-gated PR that touches `apps/api`. PR #9964
(KRTX-2429) repaired both; the full script then ran 14,048 pass / 0 fail.

**Enforcement:** The `packages` lane of `pnpm test` runs every package script,
and every push to `dev` runs it. Nothing runs it before a merge into `dev`:
that run is the author's. none yet: a pre-merge check that the attestation
covers the `packages` lane for a diff under `apps/*/src`.
