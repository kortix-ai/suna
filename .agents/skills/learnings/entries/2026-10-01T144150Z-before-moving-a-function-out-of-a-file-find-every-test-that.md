---
recorded: 2026-10-01T14:41:50Z
incident_date: 2026-10-01
---
# Before moving a function out of a file, find every test that reads that file by name, and run the package's whole suite

**Rule:** Source guards read files by path and find functions by
signature text. Before you move a function to another module, run
`rg -l "<file name>" <package>/src/**/__tests__` and repoint every guard
that names it. Then run the package's whole suite
(`pnpm --filter <package> test`), not only the focused tests: a guard that
throws inside a `describe` body reports "Unhandled error between tests",
skips every test in that block, and fails the package.

**Trigger surface:** Splitting or moving code in
`apps/kortix-sandbox-agent-server/src/harness/open-code/` (or any file a
`*-source-guards.test.ts` reads); a `packages` lane failure that names
"Unhandled error between tests".

**Incident:** 2026-10-01. #8600 (KRTX-930) moved
`maybeCreateInitialOpencodeSession` from `boot.ts` to `initial-session.ts`.
Its author ran focused tests only (the local stack needed Docker).
`boot-source-guards.test.ts` still searched `boot.ts`, so `indexOf`
returned `-1` in a `describe` body. The 4 initial-session ordering guards
stopped running, the `kortixd` package exited `1`, and `main` stayed red from
12:55Z to 14:41Z. The red blocked the v0.13.47 staging promotion (#8625).
Fixed in #8627: the guards read the module that owns the function; all
needles were present and in order.

**Enforcement:** The `packages` lane on every push to `main` (post-merge
only). None yet before the merge: a guard helper that names the missing
file and signature in its failure, instead of an unhandled error.
