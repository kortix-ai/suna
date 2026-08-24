# Session runtime recovery — design specification

Date: 2026-08-22
Status: in progress
Incident session: `ebdcac7f-58bd-4a9f-ad82-b5f536f12c9c`

## Problem

A transient or provider-confirmed sandbox stop currently destroys the usable
session experience even when Kortix still has the conversation:

- a runtime error replaces the complete chat with a full-screen error;
- Terminal and Files remain in loading or disconnected states without bounded
  recovery;
- an interrupted OpenCode response leaves an empty assistant envelope and a
  stale active-turn indicator;
- `POST /restart` accepts concurrent requests and runs overlapping provider
  `stop -> start` sequences;
- provider reconciliation records that Platinum returned `stopped`, but not the
  observation sequence that justified the transition.

The observed incident contained three restart requests within 27 seconds. One
detached restart completed after an earlier recovery and parked the session
again. A browser refresh then triggered `/start`, which woke it again.

## Invariants

1. Cached conversation content outranks recoverable runtime failure.
2. Runtime readiness gates live operations. It does not gate conversation read.
3. One `session_id` has at most one destructive lifecycle operation in flight.
4. Duplicate restart requests join the active operation. They never stop the VM
   again.
5. A provider `stopped` observation is evidence. It is not sufficient alone to
   park an active session during a live turn.
6. Terminal and Files own their failure states. Their failures do not replace
   the conversation.
7. Every loading state has a timeout, a retry path, and an observable reason.
8. An assistant envelope with zero parts is not rendered as progress after its
   runtime turn ends or disappears.

## Design

### Serialized lifecycle recovery

Use the existing `session_sandboxes.metadata` compare-and-set pattern. A restart
claim contains an operation id, start time, lease expiry, and phase. The claim is
acquired only when no unexpired restart claim exists. A duplicate request returns
`202` with `reason: restart_in_progress` and the same operation id.

Every detached completion write predicates on that operation id. A stale worker
cannot change sandbox or project status after a newer lifecycle operation wins.
The claim is cleared only by its owner.

### Provider-stop confirmation

Retain and verify the existing 60-second confirmation mechanism in
`sandbox-state-sync.ts`. One provider read does not park an active session while
a control-plane turn is active. A running observation clears the pending marker.
Two stopped observations separated by the confirmation interval permit
`provider_reconcile`.

### Session presentation

The session page always mounts chat when it has a resolved OpenCode session id.
The existing composer recovery notice exposes reconnect state and queued-send
behavior. Full-screen runtime errors remain for sessions without a renderable
conversation. The full-screen restart action sits below the error detail.

### Tool panels

Terminal and Files map transport state independently. A connecting state becomes
an actionable local error after 15 seconds. Retry re-arms the deadline and asks
the shared runtime connection to reconnect. Panel state never changes the
session phase.

### Turn cleanup

When provider reconciliation parks a sandbox, the existing stopped-state
transaction settles open turn rows. This change verifies that mechanism. Empty
assistant envelopes contain no visible parts, so cached conversation remains
readable while the runtime reconnects.

## Verification

- API concurrency test: three restart requests cause one provider stop and one
  provider start.
- API stale-worker test: an old restart cannot overwrite a newer running state.
- Reaper test: one transient stopped observation during an active turn does not
  park the session; a confirmed second observation does.
- SDK test: a recoverable runtime error preserves messages and exposes recovery
  state without making the session terminal.
- Web test: cached transcript plus runtime failure renders chat and an inline
  recovery notice. The restart button is below its message.
- Browser test: injected runtime 503 keeps the transcript visible; Terminal and
  Files show local retry controls; recovery removes the notices without reload.
- Live sandbox test: stop ingress during an active turn, restore it, and verify
  chat, Terminal, Files, queued send, and busy state.
