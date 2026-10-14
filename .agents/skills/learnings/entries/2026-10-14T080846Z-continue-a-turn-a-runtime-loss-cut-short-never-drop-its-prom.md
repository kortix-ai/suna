---
recorded: 2026-10-14T08:08:46Z
incident_date: 2026-10-06
---
# Continue a turn a runtime loss cut short; never drop its prompt as answered

**Rule:** A prompt requeued after a runtime loss nobody asked for
(`requeueAbandonedPrompt({ resumable: true })`: a provider stop, a runtime
restart) whose turn already wrote a reply goes out as ONE continuation
(`findInterruptedTurn`), never as the original prompt and never dropped as
`already_answered`. Write the ledger's "resumed" cause only after that
continuation is delivered (`markTurnResumed`), never at the stop. A turn a
person stopped, or a completed reply, gets no continuation.

**Trigger surface:** `redelivery.ts`, `queued-continue.ts` `checkTranscript`,
`sandbox-state-sync.ts` `applyStoppedState`, `runtime-restart-recovery.ts`.

**Incident:** 2026-10-06 product audit (KRTX-1732). The 2026-08-25 rule
redelivered the prompt, but the drain read the cut-off reply as an answer and
closed the row `already_answered`. Members typed "go on"; unattended workers
stopped while the ledger said "Kortix restarted it and resumed this turn".

**Enforcement:** `apps/api/src/__tests__/integration-interrupted-turn-continuation.test.ts`
(real rows: interrupted, completed, person-stopped, retry, first turn) and
`redelivery.test.ts` `findInterruptedTurn`.
