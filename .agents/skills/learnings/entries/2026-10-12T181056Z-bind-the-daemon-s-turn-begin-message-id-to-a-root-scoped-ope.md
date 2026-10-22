---
recorded: 2026-10-12T18:10:56Z
incident_date: 2026-10-12
---
# Bind the daemon's turn_begin message id to a root-scoped open turn; a turn with no messageId is settled runtime_gone at 30 minutes

**Rule:** Every open turn record must learn its user message id. A prompt delivered without a wire id (Slack, Teams, triggers, approval resume) writes a root-scoped record (`messageId: null`); `adoptRuntimeSandboxTurn` binds the id the daemon's `turn_begin` relay names to that record. Never answer `turn_begin` with `open_turn_exists` while the one open record has no id: the reaper's no-messageId ceiling (`turnNoBeginRelayMaxMs`, 30 min) settles it `runtime_gone` while the turn is still running.

**Trigger surface:** Adding a prompt producer that sends no `messageID`; changing `adoptRuntimeSandboxTurn`, the `turn_begin` relay (`harness/shared/turn-relay.ts`), the box-reaper ceilings, or the Slack/Teams stale-turn GC (`sweepStaleSlackTurns`), which trusts the ledger to decide whether a run is alive.

**Incident:** 2026-10-12, prod, an internal Slack session on the pi harness. A Slack follow-up started a long coding turn. At +30 min the reaper settled the live turn `runtime_gone`. At +43 min the Slack GC found no live turn and a thread silent for 30 minutes. It posted "This run ended without a reply" and aborted the runtime. The transcript ends in `MessageAbortedError`. Memory peaked at 26 %, and the daemon never restarted. Any Slack/Teams/trigger turn that ran longer than 30 minutes was exposed.

**Enforcement:** `apps/api/src/__tests__/integration-sandbox-turn-lifecycle.test.ts`: "a root-scoped delivered turn takes the message id the daemon names" and "two root-scoped open turns are ambiguous — neither takes the id".
