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
continuation is delivered (`markTurnResumed`), never at the stop or on a row
closed without a POST. A turn a person stopped, or a completed reply, gets no
continuation, on the requeued-row path and on the first-turn path alike. Read
"the turn's reply" over the whole turn: an automatic compaction re-parents the
later steps. Every continuation carries a wire id, so a second stop continues it
again within the redelivery budget. The next wake releases a held continuation.

**Trigger surface:** `redelivery.ts`, `queued-continue.ts` `checkTranscript`,
`sandbox-state-sync.ts` `applyStoppedState`, `runtime-restart-recovery.ts`,
`command-transitions.ts` `reArmRuntimeBlockedPrompts`.

**Incident:** 2026-10-06 product audit (KRTX-1732). The 2026-08-25 rule
redelivered the prompt, but the drain read the cut-off reply as an answer and
closed the row `already_answered`. Members typed "go on"; unattended workers
stopped while the ledger said "Kortix restarted it and resumed this turn".

**Enforcement:** `apps/api/src/__tests__/integration-interrupted-turn-continuation.test.ts`
(real rows: interrupted, completed, person-stopped, retry, first turn,
compaction, staged rewind, bounded observer, second stop, wake release) and
`redelivery.test.ts` `findInterruptedTurn`.
