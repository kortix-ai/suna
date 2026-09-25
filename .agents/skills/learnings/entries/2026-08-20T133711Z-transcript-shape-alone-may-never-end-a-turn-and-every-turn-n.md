---
recorded: 2026-08-20T13:37:11Z
commit: 41cd6fe1a3
---
# Transcript shape alone may never end a turn — and every turn needs a record, whoever started it

Session/turn truth rules paid for on SampleCo, 2026-08-20 (session `d1b74954`:
composer flapped "not running" over a visibly streaming session; a user prompt
delivered mid-turn was silently swallowed; PR #6657):

**1. A verdict that a turn is DEAD must be gated on the runtime's own busy
signal, not inferred from the transcript.** "A newer user message follows it"
and "its latest assistant message is completed" both read as terminal and both
occur mid-turn (prompts forwarded into a live turn; the step boundary while
tools run). The reaper cleared a streaming turn's authority at 12:48:51Z; its
step completed at 12:48:54Z. Rule: no terminal verdict while the root reports
`busy`/`retry`; an unreadable status is `unknown`, never terminal.

**2. Every runtime-initiated turn must be announced to the control plane.**
OpenCode starts turns nobody delivered (synthetic `<pty_exited>` wake-ups).
Anything keyed on "a control-plane prompt opened this turn" — `GET .../turn`,
the deadline grant, Stop — silently misses them. The daemon's `turn_begin`
relay + `adoptRuntimeSandboxTurn` close this; the general rule: when a new way
for work to START appears, audit every consumer of "is work running".

**3. A safety floor that DELETES its own retry state is a one-shot race.** The
orphan-redelivery age floor (30s) was checked once, and losing the check
cleared the record that was the only possible trigger — the user's prompt died
at age 27s. A guard that defers must leave the state it will need standing.

**4. An unnamed lifecycle event breaks every consumer keyed on the name.**
`readRootTurnState` bailed on a trailing user message, so turn-end relays
carried no `turn_message_id`: dedup vanished (double finalizes) and the strand
reconciler lost its key. When an identity read has a "give up" branch, list
what downstream keys on the identity before taking it.

*Automation:* flipped-expectation tests in `orphaned-turn-finalize.test.ts` and
`sandbox-reaper.test.ts` pin the incident timeline; `turn-begin-relay.test.ts`
and `integration-sandbox-turn-lifecycle.test.ts` pin the adoption contract.
