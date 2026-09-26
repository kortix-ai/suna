---
recorded: 2026-09-25T18:34:09Z
incident_date: 2026-09-25
commit: d6d3de1653
---
# "Accepted" read right after an async submit sees nothing yet

**Incident.** Found while tracing the sweep kill above. On prod, 1,580 of
1,604 session-creating first turns in 7 days ended `abandoned`, and none was
ever accepted. The same holds every day back to the ledger's first rows
(2026-08-19). A median of 12.6 s after start, the ledger dropped the turn while
OpenCode ran it. In 7 days, 125 such turns demonstrably kept working, 75 for
more than 10 minutes. With no authority on record, every reader of "is this
session working?" saw the first turn as idle: the stale-turn sweeps, the
inbox, and `GET .../turn`.

**Cause.** Boot calls `prompt_async`, then reconciles acceptance at once.
`prompt_async` answers `204` before OpenCode writes the user message and
before its loop marks the root busy. On 1.18.23 against a cold instance the
message is absent at +11 ms, and the root is busy only about 300 ms later
(1 s on prod). The reconcile read "absent / unanswered" as proof the prompt was
dropped and sent `turn_abandoned`. The later `turn_begin` could not re-adopt
the turn, because the ledger already knew that message.

**Rule.** After an asynchronous submit, "not visible yet" is `unknown`, never
terminal. Only the party that made the submit may wait on it, and only for a
bounded grace. Absence is proof only when no one has submitted in this
process's lifetime.

**Enforcement.** `apps/kortix-sandbox-agent-server/src/__tests__/initial-turn-lifecycle.test.ts`:
absent and unanswered stay `unknown` while this boot awaits pickup, then
promote on busy. Both are abandoned after the 15-minute grace. A reused root
stays abandoned at once. A busy frame promotes the pending first turn before
any `turn_begin`.
