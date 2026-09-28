---
recorded: 2026-09-28T23:56:47Z
incident_date: 2026-09-28
---
# Check a durable repair target exists before you delete the thing it repairs, and log only the outcome you got

**Rule:** Before a repair deletes or replaces the artifact it is repairing,
prove the durable record the repair acts on exists. A warning must name the
outcome that actually happened, never the outcome the code intended.

**Trigger surface:** Any turn-end / reaper reconciliation that removes a
message or row and then re-queues it from a separate durable record. Also any
`logger.warn` whose text is fixed while its `outcome` field varies.

**Incident:** 2026-09-28, prod. `reconcileForwardedTurnsAtEnd` fired
`[forwarded-turns] stranded forwarded prompt re-queued` 293 times in a day
against a baseline of ~10. 289 of the 293 carried `outcome: no_row`: the
durable `continue_session` row was not found, so nothing was re-queued, but the
code had already deleted the user's message from the runtime and the warn still
claimed "re-queued". The reconcile treats every open `session_turns` row keyed
to a placed user message as a re-queueable forwarded prompt, yet only a durable
queue delivery can be re-queued; a DIRECT delivery (trigger, channel reply,
approval resume, first prompt) and an adopted box-initiated turn have no queue
row. A few long-lived sessions produced almost all of the lines.

**Enforcement:** `forwarded-strand-reconcile.test.ts` — a candidate whose
`hasRequeueableRow` is false is left in the transcript and never removed or
counted as re-queued; a requeue that answers `exhausted` is not logged as one.
`integration-forwarded-strand-reconcile.test.ts` proves the SQL guard: a
ledger-only turn and a non-`succeeded` row both leave `deletedMessages` empty.
