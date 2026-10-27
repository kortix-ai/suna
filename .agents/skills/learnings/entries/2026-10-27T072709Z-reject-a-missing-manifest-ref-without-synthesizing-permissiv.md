---
recorded: 2026-10-27T07:27:09Z
incident_date: 2026-10-27
---
# Reject a missing manifest ref without synthesizing permissive agent grants

**Rule:** Keep strict manifest reads fail-closed when the configured Git ref is absent. Return an actionable 409, not an unhandled 500 or an absent-manifest result.

**Trigger surface:** Reading project agents before session creation or authorization.

**Incident:** On 2026-10-27, an unseeded managed repository received pushes without its configured default branch. Six session-create requests failed with `git ls-tree main` exit 128 (KRTX-3538).

**Enforcement:** `apps/api/src/projects/git/manifest-missing-ref.test.ts` checks empty repositories, a non-default-only push, and a valid commit without a manifest through real Git reads and the HTTP error handler.
