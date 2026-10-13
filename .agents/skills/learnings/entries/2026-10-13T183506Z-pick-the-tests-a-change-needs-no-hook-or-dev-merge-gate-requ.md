---
recorded: 2026-10-13T18:35:06Z
incident_date: 2026-10-13
---
# Pick the tests a change needs; no hook or dev merge gate requires a test attestation

**Rule:** Run the tests that cover the change, narrowest first, and list them in the PR body. A diff that no test reads (docs, a skill, a standalone script) needs no run. No hook or `dev` merge gate requires a `tests/attestations/` file. This supersedes the 2026-10-08 entry "Before merging a PR into dev, run pnpm test:verify on its head". `dev` is gated after the merge by the `Tests` run on every push; a red run blocks the next promotion, and the author fixes forward.

**Trigger surface:** Pushing a branch, merging a PR into `dev`, or editing `.githooks/pre-push`, `AGENTS.md`, or the `contributing` / `testing` skills.

**Incident:** 2026-10-13. A 3-file diff (two READMEs and a new standalone script) could not be pushed until a full diff-scoped `pnpm test` ran green. Of the last 80 local `pnpm test` runs, 45 took more than 5 min (mean 373 s) and 36 had a failed lane. Development stalled on runs that tested nothing the diff touched. The pre-push attestation check was the only enforcement; no CI job read the file. The company factory merge gate (G11) still reads attestations on factory PRs, so `pnpm test` keeps writing the file and `pnpm test:verify` stays.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` "pre-push requires no test attestation" fails if `.githooks/pre-push` calls `verify-attestation` again.
