---
recorded: 2026-11-02T16:27:37Z
incident_date: 2026-11-02
---
# Move CI_RUNNER_L off vulcan for the release when supabase start cannot bind its port after a clean sweep

**Rule:** When a release-suite `core-flows` or `core-db` job on a `vulcan-*` runner fails `supabase start` with `failed to bind host port 0.0.0.0:54322/tcp: address already in use`, and the port sweep before it passed, treat it as the runner. Do not wait for the automatic rerun on vulcan. Set `CI_RUNNER_L` to `ubuntu-24.04` (`gh variable set CI_RUNNER_L --body ubuntu-24.04`), dispatch the next run, and restore the old value after the release merges. Say both changes on the release PR. This extends the 2026-10-19 rule "Check which runner pool CI_RUNNER_* selects before reading a red release suite".

**Trigger surface:** Reading a red release-suite contract lane whose log stops in "Run the root test lane" before any test ran.

**Incident:** 2026-11-02, release v0.14.15, run 41466337549. `CI_RUNNER_*` moved to the `vulcan-*` pools at 07:49Z. Three of four core lane jobs died at bootstrap: attempt 1 `core-db` and `core-flows`, then the rerun's `core-flows`. Each bound 54322 cleanly in the sweep, then Docker failed to bind it seconds later. With no test signal from `core-flows`, a `MEMORY.md` failure in `core-db` surfaced only on the rerun. Run 41477468662 on `ubuntu-24.04` passed every lane on the first attempt.

**Enforcement:** none yet: the enforcer to build is the 2026-10-19 one, a Promote preflight that prints every `CI_RUNNER_*` value and fails when a release-suite tier points at a pool without a recent green nightly.
