# Task B1 report — Parallelize `planInstall` file reads (`packages/registry`)

## Summary

Parallelized the per-file `resolved.readFile()` calls inside `planInstall`'s
`visit` (in `packages/registry/src/install.ts`) using the existing `mapLimit`
helper (bounded concurrency = 8), while keeping `plan.writes` order, hashes,
`plan.warnings`, and `plan.units[].writes` byte-identical to the sequential
implementation. Dependency recursion (`registryDependencies`) is untouched —
still depth-first and sequential; only the item's own file reads run
concurrently.

## Files changed

- `packages/registry/src/fetch.ts` — added `export` to the existing private
  `mapLimit<T, R>` helper (~line 175). No behavior change.
- `packages/registry/src/install.ts`
  - Imported `mapLimit` from `./fetch`.
  - Added `const FILE_READ_CONCURRENCY = 8` and a small `FileReadResult`
    discriminated-union type (`{ ok: true; write: PlannedWrite } | { ok: false; warning: string }`).
  - Replaced the sequential `for (const file of resolved.item.files ?? [])`
    loop with `mapLimit(resolved.item.files ?? [], FILE_READ_CONCURRENCY, ...)`,
    where each work item resolves `targetRaw`/`target`, calls
    `resolved.readFile(file.path)`, and returns either `{ ok: true, write }` or
    `{ ok: false, warning }` on read failure (identical warning text to the
    original: `could not read "<path>" for "<name>": <err.message>`).
  - After the concurrent map resolves, a plain `for` loop iterates the
    results **in original file order** (guaranteed by `mapLimit`, which
    writes into `out[i]` by index regardless of completion order) and pushes
    successes to `writes`/`plan.writes`, failures to `plan.warnings` — exactly
    mirroring what the sequential code did, so output is byte-identical.
- `packages/registry/src/install.test.ts` (new, co-located, matches the
  `manifest.ts` / `manifest.test.ts` pattern in this package) — 4 tests.

## TDD evidence

**RED** (before the `install.ts`/`fetch.ts` changes, tests written first):

```
src/install.test.ts:
  expect(resolvers.length).toBe(5);      → Received: 1  (concurrency test)
  expect(resolvers.length).toBe(8);      → Received: 1  (bound test)

 2 pass
 2 fail
 8 expect() calls
```
The two concurrency-shaped tests failed against the still-sequential code
(reads happened one at a time, so only 1 `readFile` was in flight when
checked immediately after calling `planInstall`). The order/hash and
warning-text tests already passed unchanged, as expected (behavior for those
was never meant to change).

**GREEN** (after implementing the `mapLimit`-based read loop):

```
 4 pass
 0 fail
 13 expect() calls
Ran 4 tests across 1 file. [24.00ms]
```

**Regression-catch sanity check**: temporarily bumped
`FILE_READ_CONCURRENCY` from `8` to `100` (reverting the "bounded" part of the
change without reverting the parallelization) and reran the focused test —
the bound test failed as expected (`resolvers.length` was `20`, not `8`),
confirming a test would catch this specific regression. Restored `8`
immediately after and re-verified full green.

## Tests added (`packages/registry/src/install.test.ts`)

1. `reads for a multi-file item run concurrently, not one at a time` — a
   5-file item with a `readFile` that increments/decrements an `active`
   counter and stashes manual resolvers (never auto-resolving). Asserts,
   *immediately* after calling `planInstall` (no `await` yet), that all 5
   reads were already kicked off (`resolvers.length === 5`) and that
   `maxActive >= 2`, i.e. genuinely concurrent, not sequential. Then releases
   all resolvers and awaits the plan to confirm it still completes with 5
   writes. (Relies on the fact that calling an `async` function runs
   synchronously up to its first internal `await`, so `mapLimit`'s initial
   batch of workers — and their first `readFile` calls — fire synchronously
   before `planInstall(...)`'s returned promise is ever awaited; no timers or
   flakiness involved.)
2. `never runs more than 8 reads at once, even with 20 files` — same pattern
   with 20 files. Asserts exactly 8 reads are in flight immediately after
   calling `planInstall` (proving the *bound*, not just "some concurrency").
   Then drains the resolvers in waves (release everything currently queued,
   flush a macrotask via `setTimeout(…, 0)`, repeat) until all 20 have
   settled, and asserts `maxActive` never exceeded 8 across the whole run,
   and all 20 writes landed.
3. `output order and hashes match input file order (sequential-equivalent)` —
   4 files with distinct content read via a plain `async` `readFile` (no
   artificial delay/reordering). Asserts `plan.writes` target/content order
   equals input file order and each `hash` equals `hashContent(content)` —
   the exact invariant the brief asks for (order == input order, hash ==
   `hashContent(content)`), without pinning to a specific fixed skill/file
   list.
4. `a rejected read yields the exact warning text and skips only that file` —
   3 files, the middle one's `readFile` rejects with `Error('boom')`.
   Asserts `plan.warnings` equals exactly
   `['could not read "b.md" for "partial": boom']` and `plan.writes` contains
   only `a.md` and `c.md`, in order, with correct content — i.e. the failure
   is isolated and the rest of the plan is unaffected.

All four are deterministic: no real network/filesystem, no arbitrary sleep
durations relied upon for correctness (the `setTimeout(…, 0)` in test 2 is
only a macrotask-boundary flush inside a drain loop, not a timing
assumption), no comments in the test file, no `.only`.

## Test results

```
$ pnpm --filter @kortix/registry test
 47 pass
 0 fail
 93 expect() calls
Ran 47 tests across 3 files. [27.00ms]

$ pnpm --filter @kortix/registry typecheck
tsc --noEmit   (clean, no output)
```

All pre-existing tests in `packages/registry/src/__tests__/registry.test.ts`
(including its `planInstall` describe block, which covers dependency
ordering, unresolved-dependency warnings, and `exists` flagging) still pass
unchanged — confirming the refactor didn't alter any of those observable
behaviors.

## Self-review

- **Completeness**: matches all brief steps — `mapLimit` exported (not
  duplicated), `visit`'s file-read loop parallelized with bound 8, dependency
  recursion untouched, results reduced back in original order.
- **Determinism**: verified via the regression-catch check above (bound
  test fails if the limit is defeated) and via the order/hash test (proves
  output ordering is input-order, not completion-order, which is exactly
  what `mapLimit`'s `out[i] = await fn(items[i])` indexing guarantees).
- **YAGNI**: no new dependency, no new exported surface beyond the required
  `mapLimit` export; `FileReadResult` is a private, minimal discriminated
  union scoped to this one loop.
- **Test output cleanliness**: only the new `install.test.ts` file's 4 tests
  plus the existing 43 run clean, no console noise, no skipped/todo tests.
- **Side effect of exporting `mapLimit`**: `packages/registry/src/index.ts`
  does `export * from './fetch'`, so `mapLimit` is now part of the package's
  public API surface (previously private to `fetch.ts`). This matches the
  brief's explicit "add `export`" instruction (the brief's alternative,
  lifting it to a shared util module, was not required and would have been
  more churn for the same effect); flagging it here in case a narrower
  export (e.g. only from `fetch.ts` directly, not re-exported at the package
  root) is preferred later.

## Concerns

None blocking. The only note is the public-API-surface point above (exporting
`mapLimit` from the package root via the existing `export * from './fetch'`
in `index.ts`) — functionally harmless and explicitly sanctioned by the
brief, just worth a maintainer's awareness.
