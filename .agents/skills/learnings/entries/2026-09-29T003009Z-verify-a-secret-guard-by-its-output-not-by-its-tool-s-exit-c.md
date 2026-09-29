---
recorded: 2026-09-29T00:30:09Z
incident_date: 2026-09-29
---
# Verify a secret guard by its output, not by its tool's exit code

**Rule:** A secret guard must check its result, not trust its tool: verify the staged content is encrypted, and run the repo-pinned tool rather than whatever version is installed globally.

**Trigger surface:** Editing `.githooks/pre-commit` / `pre-push`, bumping dotenvx, or adding any `… || true` step to a guard.

**Incident:** 2026-09-29, near-miss, no secret leaked. #8005 switched the pre-commit backstop to `dotenvx protect`, which exists only from dotenvx 2.29. The hook preferred a global dotenvx; on a machine with global 2.14.0, `protect` printed "unknown command" and exited 0, and step 1's `dotenvx encrypt -f apps/api/.env --no-armor || true` reported "no change" and left an appended plaintext value in place. Reproduced: a plaintext line staged in a tracked `.env` passed pre-commit and pre-push. The repo-pinned 1.75.1 encrypts correctly.

**Enforcement:** `.githooks/pre-commit` step (1b) reads every staged `.env` from the index and exits 1 on any non-empty value that is not `encrypted:…`, whatever dotenvx does; both hooks resolve the workspace-pinned dotenvx first; the backstop runs `protect` only on dotenvx ≥ 2.29, `ext precommit` below.
