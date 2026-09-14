# Live-turn prompt steering

Status: approved in chat on 2026-09-03.

## Problem

Kortix persists composer messages in `session_lifecycle_commands`. The current
admission gate refuses every message while `activeTurns` contains a live turn.
The message therefore remains only in PostgreSQL until the turn-end relay or a
later reconciliation promotes it.

This behavior breaks the queue contract. A message sent while the agent works
must reach the runtime during that work. The runtime must receive all messages
in user-send order. The agent can then read them at its next safe tool boundary
and change direction without a page refresh.

The regression is deterministic. The test named `a prompt submitted into a live
turn stays queued until that turn ends` currently passes. The real-sandbox
mid-turn gate fails because the second message does not reach OpenCode within 20
seconds and remains stranded after the first turn completes.

Git history identifies the regression. Commit `22332018c4` restored the
`turn_active` refusal after commits `2de2733c99` and `acce6fbe22` had reverted
the same design. The incident register records the original product failure.

## User contract

1. Pressing Enter creates one durable prompt row immediately.
2. A live turn does not hold that prompt in the control plane.
3. Kortix forwards queued prompts to OpenCode in canonical FIFO order.
4. OpenCode persists each prompt while the current turn is still active.
5. The agent reads the prompts at the next safe runtime boundary.
6. Normal queue steering does not hard-kill an operating-system process.
7. Stop remains the explicit hard-abort control.
8. Refresh, reconnect, or a dropped relay cannot duplicate, reorder, or lose a
   prompt.
9. The queue row disappears only after runtime evidence proves consumption.

## Selected approach

Use OpenCode's native mid-turn prompt queue with a durable Kortix front buffer.

Kortix keeps PostgreSQL as the durability and recovery authority. It does not
use turn completion as the ordinary delivery boundary. It serializes the
network posts, forwards each accepted row into the live OpenCode session, and
uses OpenCode as the execution queue after persistence.

The design rejects two alternatives:

- Turn-end-only delivery repeats the current failure. The agent cannot see new
  instructions while it works, and a missed terminal relay strands the queue.
- Hard-aborting the active turn on every Enter behaves like Stop. It can kill a
  migration, Git operation, or file write at an unsafe point. It also discards
  useful unfinished work instead of steering it.

## Data flow

### 1. Durable submission

`POST /projects/:id/sessions/:sessionId/prompts` writes one
`continue_session` command before returning `202`.

The canonical FIFO tuple remains:

1. `payload.clientSentAtMs`
2. `payload.wireMessageId`
3. `commandId`

Older producers without `clientSentAtMs` use `created_at` as the fallback. All
SQL and in-memory comparisons use the same bytewise ordering.

### 2. Admission

Admission enforces only delivery serialization:

- another network delivery for the same session is still in flight;
- an older non-held prompt still precedes this row.

Live turn authority is not an admission refusal. The drain still reads live
turn authority to decide whether the client wire ID needs re-minting above the
current transcript tip.

### 3. Runtime forwarding

The drain posts the head row to OpenCode's `prompt_async` endpoint. On
acceptance it marks the row `forwarded`. A forwarded row remains visible as
`delivering` until runtime evidence proves that a step consumed it.

After one row is accepted, the drain durably promotes the next FIFO row and
starts its targeted drain. This chain forwards the complete pending burst while
the original turn remains active. It never runs two same-session network posts
concurrently.

Delivery-time chaining and terminal promotion serve different purposes:

- delivery-time chaining is the normal low-latency path;
- terminal promotion is a recovery wake for rows left in PostgreSQL by a
  failed post, process crash, stale daemon, or dropped chain kick.

### 4. Runtime consumption

OpenCode owns the safe execution boundary. It finishes or returns from the
current tool call, reads the newly persisted user messages, and continues with
the newest instructions plus any remaining relevant work.

Kortix does not infer consumption from persistence. The daemon and turn ledger
identify which user message IDs an OpenCode step read. Turn-end reconciliation
then:

- closes every forwarded row proven consumed by that step;
- leaves unread forwarded rows open;
- removes and requeues a stranded placement when the transcript proves it was
  ordered below an answer;
- never redelivers a row already answered.

### 5. Completion and recovery

The discriminated turn-completion result remains:

- `closed`
- `already_closed`
- `identity_mismatch`
- `no_active_turn`
- `non_terminal`

The daemon deduplicates only terminal acknowledgements. Identity mismatches and
transient root reads retry. The reaper can independently prove a turn terminal,
clear stale authority, reconcile forwarded rows, and promote any remaining
PostgreSQL row.

Completion correctness protects recovery. It does not serialize ordinary
prompt delivery.

## Stop behavior

Stop remains a separate explicit operation.

- The active OpenCode turn is aborted.
- PostgreSQL-only rows become held.
- Forwarded but unread rows are removed from OpenCode when the runtime allows
  removal, then become held.
- A forwarded row proven read by the aborted step closes as consumed.
- Releasing the hold or selecting Send now resumes from canonical FIFO order.

Normal Enter never invokes this path.

## Failure handling

- Every post uses the existing delivery idempotency key.
- Ambiguous transport failures retain the dedupe claim and reconcile against
  the transcript before any retry.
- Runtime-unreachable failures remain queued without spending the ordinary
  dead-letter budget.
- A lost targeted-drain kick falls back to the scheduler and terminal recovery.
- Prompt text never appears in structured lifecycle logs.
- No database migration is required.

## Interface scope

This change modifies internal API and daemon behavior only.

It makes no UI, composer, database-schema, queue-management, or public SDK
surface change. Existing `202` responses and queue endpoints remain compatible.

## Test design

### Deterministic regression tests

1. Replace the current `turn_active` expectation with a test that forwards a
   prompt while live turn authority exists.
2. Assert that live authority triggers wire-ID re-minting, not admission
   refusal.
3. Assert that an accepted delivery promotes exactly the next canonical FIFO
   row.
4. Assert that two same-session network posts never overlap.
5. Assert that reverse database insertion order cannot reverse client-send
   order.
6. Assert that a terminal wake repairs a missed delivery-time chain.
7. Assert that consumption closes all and only the forwarded rows read by the
   terminal OpenCode step.
8. Assert Stop distinguishes forwarded-unread from forwarded-consumed rows.

### Real-sandbox API gate

Run the existing `integration-inbox-midturn-forward.test.ts` with three queued
messages:

1. Start a turn containing a 36-second shell loop.
2. Submit prompts B, C, and D while that tool runs.
3. Assert all three reach OpenCode within 20 seconds and before prompt A's
   assistant message completes.
4. Assert their OpenCode message IDs preserve B, C, D order.
5. Assert prompt A is not hard-aborted.
6. Assert OpenCode processes B, C, and D after the safe boundary.
7. Assert the turn ledger closes every consumed prompt exactly once.
8. Assert the prompt endpoint becomes empty without refresh.

### Browser gate

Drive the real session page against the branch stack:

1. Start a long tool call.
2. Send at least three messages while it runs.
3. Observe the `202` requests and immediate FIFO queue paint.
4. Assert each message transitions to runtime-backed `delivering` while the
   original turn remains active.
5. Assert responses follow FIFO order without reload.
6. Hard-refresh during the run and assert the same order and states.
7. Drop one terminal relay and assert reconciliation completes without reload.
8. Press Stop in a separate run and assert no held prompt leaks onto the wire.

## Delivery

Implementation stays on `session-queue-turn-end-sync` and draft PR `#7103`.
The `preview` label remains. The PR must not merge without explicit approval.
Preview verification must record the deployed SHA and origin. A preview
infrastructure failure is not product verification and must remain reported as
blocked.
