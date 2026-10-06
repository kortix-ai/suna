---
recorded: 2026-09-02T09:47:24Z
incident_date: 2026-09-02
commit: ef2163ba25
---
# `bun test` is not the SDK's gate — `bun run test` is, and the difference is 532 failures

**When:** judging whether a change to `packages/sdk` is green. The package's own
script is `find src -name '*.test.ts' | xargs -n1 -P4 bun test --isolate` — ONE
FILE PER PROCESS. Running a bare `bun test` in that directory puts all 188 files
in one process, where the suite's `mock.module` calls replace modules wholesale
and take unrelated files down with them: measured 2230 pass / **532 fail**
against 2770 pass / **0 fail** for the same tree under the real script. The
failures name real-looking things (`backendApi.post is not a function`,
`Failed to write file (502)`) and point at the victim, never the polluter.
**Rules:** (1) use `bun run test`, never `bun test`, to judge this package;
(2) a new suite here will pass alone and fail in a shared process — that is the
pre-existing leak, not your code, and the way to tell is a git-stash baseline of
the SAME command, both numbers written down; (3) when the two numbers differ by
hundreds, suspect the runner before the diff.
**The other half:** adding exports fails
`public-surface`/`public-type-surface` by design. Those are a QUESTION — "did I
mean to change the public API?" — not a test to re-record. Answer it by
set-comparing old against new and confirming REMOVED is empty; additive is safe,
a removal or rename is a breaking change needing an alias. Regenerate only then,
with `UPDATE_SURFACE_SNAPSHOT=1` / `UPDATE_TYPE_SURFACE_SNAPSHOT=1`.
*Near-miss:* the filesystems SDK surface looked like it had broken 542 tests;
the real number was 2 (both snapshots), both additive, both expected.
*Enforcer:* the package's `test` script already encodes the right invocation —
the trap is only for someone who types `bun test` out of habit.
