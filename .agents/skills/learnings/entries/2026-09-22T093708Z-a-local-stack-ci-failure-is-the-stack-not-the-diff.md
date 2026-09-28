---
recorded: 2026-09-22T09:37:08Z
incident_date: 2026-09-22
commit: 5cad939147
---
# A local-stack CI failure is the stack, not the diff

**Rule:** when a `core` or `browser` lane fails, find the first error before
the test list. `local Supabase start exited with code 1` at
`tests/src/core/local-stack.ts` with `failed to set up container networking`
is the runner's docker, and the flows it gates never ran — nothing asserted
false. Re-run that lane; do not touch the code, and do not report the re-run
as a fix. If it fails the same way twice, that is a signal about the runner
and belongs in a report, not in a third re-run. **Near-miss:** PR #7483's core
lane failed exactly this way while `sdk`, `flow-runner-unit`,
`route-coverage` and `worktree-unit` passed in the same lane; the re-run went
green with no change. *Enforcer:* none.
