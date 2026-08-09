# Autonomous Agent Vertical Slice — Implementation Plan

Status: local implementation complete; remote delivery pending approval
Date: 2026-08-06
Spec: `docs/specs/2026-08-06-autonomous-agent-harness.md`

## Objective

Ship the smallest control-plane layer that lets the existing platform `meta`
agent pursue reviewed goals across disposable sessions without confusing idle
with completion.

## Ordered slices

1. **Goal declaration and push**
   - Add and validate v2 `goals:` entries.
   - Parse typed goals from `kortix.yaml`.
   - Desugar each active `push` into the existing durable trigger catalog.
   - Keep OpenCode as the only session runtime.

2. **Generated state**
   - Add `project_tasks` with dependency, assignment, idempotent creation, and
     atomic expiring claims.
   - Add append-only `project_goal_observations` with project/goal/metric range
     indexes.
   - Apply and reverse the migration against isolated test data.

3. **Control-plane contracts**
   - Add authenticated project API routes for goal reads/push/observations and
     task CRUD/transitions/claims.
   - Gate every mutation with an existing leaf project action.
   - Add ke2e route coverage and real HTTP tests.

4. **SDK**
   - Add framework-free additive goal and task client functions.
   - Export them through the canonical root and project facade.
   - Record RED, GREEN, typecheck, full suite, and packed-install evidence in
     `packages/sdk/PROGRESS.md`.

5. **CLI and meta agent**
   - Add `kortix goals ls|show|push|observe`.
   - Add `kortix tasks ls|show|new|claim|done|block`.
   - Use SDK contracts, not host-local fetches.
   - Extend the managed meta guide with task claims, explicit progress, repo
     write-back, and escalation rules.

6. **Liveness and authority**
   - Persist coordinator/worker identity, immutable bounds, deadline, admitted
     iterations, progress refs, settlement replay state, escalation, and blocker
     fields on `project_tasks`.
   - Expose separate `/worker`, `/progress`, and `/no-progress` mutations through
     API, SDK, and CLI. Register bounds and the initial prompt in one transaction.
   - Best-effort drain the initial prompt command. Report local `queued|drained`
     state without claiming remote delivery.
   - Admit bounded worker LLM requests through an atomic PostgreSQL iteration
     CAS. Load token/cost from server gateway ledgers before admission and again
     after actual usage recording.
   - Use the existing singleton project-trigger scheduler to sweep wall,
     token, cost, iteration, and compute growth. Do not add a scheduler.
   - Fence each bounded worker to one durable in-flight gateway request. Settle
     every completion/error by request ID. Expire a crashed request at the worker
     wall deadline. Accept only that request's token/cost overshoot because actual
     provider usage is unavailable pre-dispatch. Keep iteration admission exact.
   - Permit one idempotent no-progress continuation. Then atomically block,
     release, queue server-owned worker stop, and wake the coordinator through
     the lifecycle outbox.
   - Do not accept session idle or an empty not-yet-prompted session as task or
     goal completion.
   - Prevent the reserved meta principal from merging, pushing a protected
     branch, stopping arbitrary sessions, or using broad project write.

7. **Verification and delivery**
   - Run focused package tests and typechecks.
   - Run DB migration lint/check and local apply/read-back.
   - Run real CLI processes against the live local API with a real JWT/session
     token.
   - Exercise default, conflict, expiry, blocked, unmeasurable, stalled, and
     explicit-push paths.
   - Push, open a PR, wait for required checks, merge to `main`, follow Deploy
     Dev, prove the deployed SHA, and repeat the black-box API/CLI behavior on
     Dev.

## Deferred by design

- A second scheduler, heartbeat daemon, wake queue, or workflow engine.
- ACP and multi-harness runtime transport.
- Prime Agent's local daemon, Jupyter/ZMQ topology, and `dill` snapshots.
- Vector memory as an authoritative store.
- Online weight updates or claims of AGI.
- Organization charts, roles, epics, and additional orchestration nouns.

## Delivery state

- Local implementation and focused local verification are complete on `agi-kernel`.
- A local Supabase password-grant JWT exercised goal reads, manual goal push,
  task claim, worker registration, progress, evidence-bound completion,
  settlement replay, continuation, escalation, and stop through the real HTTP
  server, PostgreSQL tables, and lifecycle outbox.
- No claim of AGI, production readiness, or remote user-visible delivery follows from local outbox state.
- The branch remains local because remote delivery requires explicit user approval.
- PR checks, merge, Deploy Dev, deployed-SHA proof, and Dev black-box verification remain pending.
