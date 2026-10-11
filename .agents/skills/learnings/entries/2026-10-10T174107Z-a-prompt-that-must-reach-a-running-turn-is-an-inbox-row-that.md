---
recorded: 2026-10-10T17:41:07Z
incident_date: 2026-10-10
---
# A prompt that must reach a running turn is an inbox row that steers, and a turn end is never inferred from parent links after a steer

**Rule:** A server-side producer whose prompt the agent needs during its
current turn writes an inbox row (`clientMessageId`, `placement: 'composer'`,
`delivery: 'steer'`), never an automation row. An automation row is invisible
in the queue strip and waits for the whole turn to end. A steer whose id was
not placed against the live transcript (`remintOnDelivery`) is re-minted
before the POST. kortixd ends a turn only on OpenCode's own answer
(`/session/status`), never on a transcript scan alone: after a steer the next
step is parented on the steered message, so "a different parent" is not "a
different turn".

**Trigger surface:** Adding a producer that calls
`enqueueContinueSessionCommand`; changing `deliverSteer`; changing
`readRootTurnState`, `reconcileFinishedFirstTurn` or any turn-end relay in
`apps/kortix-sandbox-agent-server/src/harness/open-code/turn-relay.ts`.

**Incident:** 2026-10-10, reported in triage. Two connector accounts connected
during one long turn. Each "connector was just connected" notice arrived after
the turn ended, one extra turn each, and the queue never showed them. The fix
made the notice a steer. Live verification then found two steer defects: a
server-minted id (dated 2 min back) rendered the steered message above its
turn, and an event-stream reconnect inside the first post-steer step relayed a
false turn end (the session read idle for 90 s while the agent worked). Fixed
on branch `connector-queue`.

**Enforcement:** `apps/api/src/connectors/notify-session.test.ts` (inbox row,
steer), `apps/api/src/projects/session-lifecycle/queued-continue-steer.test.ts`
(re-mint before the steer POST),
`apps/kortix-sandbox-agent-server/src/__tests__/steered-turn-reconcile.test.ts`
(a busy root relays no end).
