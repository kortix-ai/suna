---
recorded: 2026-08-18T21:18:00Z
incident_date: 2026-08-18
commit: bbe5e9dad5
---
# A test lane that rewrites tracked files is a concurrent writer; never `git add -A` beside it

**When:** committing while any background job runs — especially a publish,
release, codegen, or packaging check.

Every CI job on PR #6526 suddenly failed in setup: API typecheck in 11s,
Frontend build in 20s, all three test workers under 70s, none of them running
a single test. The error was `ERR_PNPM_OUTDATED_LOCKFILE — pnpm-lock.yaml is
not up to date with packages/sdk/package.json`. Local runs stayed green
throughout, because the local tree was fine.

The cause: `pnpm test -- --packages-only` was running in the background while
a commit was made with `git add -A`. That lane's publish check temporarily
rewrites every publishable `package.json` — version to `0.0.0-local-test`,
and it strips fields such as `keywords` — then restores them when it finishes.
The blanket add captured that mutated state mid-run and committed four
packages pinned to `0.0.0-local-test` with no matching lockfile.

The rule: **stage explicit paths, never `git add -A`, when anything else could
be writing the tree.** Treat a test lane that mutates tracked files as a
concurrent writer with the same care as a parallel agent (see
[[shared-worktree-parallel-agent-wipe]] and
[[primary-checkout-may-be-parallel-work]]).

Two diagnostics worth keeping: **a whole-matrix failure in well under the
usual runtime is a setup failure, not a test failure** — read the install step,
not the test output. And **reproduce the exact CI step** (`pnpm install
--frozen-lockfile`) rather than the lane it belongs to; it fails in one second
and names the file.
*Incident:* PR #6526, one full CI cycle lost; caught by reading the install
step after the failure pattern (fast + everything) ruled out the tests.
