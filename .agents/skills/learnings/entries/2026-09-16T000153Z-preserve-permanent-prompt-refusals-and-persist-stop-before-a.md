---
recorded: 2026-09-16T00:01:53Z
incident_date: 2026-09-15
commit: 6b1aea2907
---
# Preserve permanent prompt refusals and persist Stop before acknowledging it

**Incident.** A production customer session
retained a binding to a disabled Gmail connector. The proxy returned `409`,
but delivery discarded the body and retried until `delivery outcome: pending`.
The UI displayed Thinking although the model received no prompt. Stop marked
claimed rows only in their payload, so reload still read `delivering`.

**Rule.** Validate connector requirements before enqueueing. Preserve permanent
refusals at delivery and never retry them as readiness failures. Persist the
public hold for claimed rows before acknowledging Stop. Check that hold before
each delivery attempt. Inspect stored bindings when the resolved scope omits
a disabled connector; a resolved scope is not a list of all stored bindings.

**Enforcement.** `SESS-29` exercises refusal, Stop, fresh GET, and Resume through
HTTP with PostgreSQL read-back. `session-prompts.test.ts` covers admission
refusals and reload. `queued-continue-inbox-delivery.test.ts` proves a connector
refusal sends once and Stop prevents a second POST after a transient failure.
Production recovery removed the stale binding through the session scope API.
The original hello received an assistant reply, and `GET /prompts` returned `[]`.
