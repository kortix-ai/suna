# Session runtime recovery — implementation plan

Spec: `docs/superpowers/specs/2026-08-22-session-runtime-recovery-design.md`
Delivery: isolated worktree -> PR -> merge to `main` -> Deploy Dev -> dev proof.

## Task 1 — Pin the incident with failing tests

- Add restart-concurrency and stale-completion tests around
  `apps/api/src/projects/session-lifecycle/actions.ts`.
- Add provider-stop confirmation tests around the reaper decision.
- Add SDK phase/presentation tests for recoverable runtime errors.
- Add web behavior tests for transcript preservation and vertical recovery CTA.
- Run each test before implementation and record the expected failure.

## Task 2 — Serialize restart

- Add a metadata CAS claim with a bounded lease.
- Return the active operation for duplicate requests.
- Fence every detached write by operation id.
- Record phase, completion, and failure evidence.

## Task 3 — Confirm provider stops

- Reuse `pendingStopObservedAtMs` as a two-observation confirmation marker.
- Keep active-turn authority on the first observation.
- Clear the marker on a running observation.
- Preserve the existing authoritative webhook and manual-stop paths.

## Task 4 — Preserve the session surface

- Move recoverable runtime errors below the chat mount decision.
- Add one inline recovery notice above the composer.
- Keep the restart button below the message.
- Keep full-screen errors only for terminal identity/access states.

## Task 5 — Bound Terminal and Files recovery

- Add explicit timeout and retry states.
- Retain last-known content during recovery.
- Ensure panel errors never set the session runtime terminal.

## Task 6 — Reconcile interrupted UI artifacts

- Remove empty assistant envelopes after runtime-gone settlement.
- Verify stale active-turn state clears through the existing control-plane row.

## Task 7 — Prove and deliver

- Run focused tests, SDK gates, repository tests, package tests, and browser
  journeys.
- Exercise a real cloud sandbox with injected stop/recovery.
- Open and merge the PR.
- Follow Deploy Dev and verify the deployed SHA.
- Repeat the incident sequence on `dev.kortix.com` without a hard refresh.
- Append the incident rule to `.claude/skills/learnings/SKILL.md`.

