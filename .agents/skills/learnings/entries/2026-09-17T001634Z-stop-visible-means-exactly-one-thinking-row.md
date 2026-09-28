---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# Stop visible means exactly one Thinking row

Three reports in one day showed Stop with no Thinking row. Each gate added to the
row reopened the gap: pending delivery with a visible queued bubble, and a working
turn chosen from an aborted reply. With a stalled live stream the tab held a Quick
Queue interrupt's aborted reply without its completion stamp, so the working-turn
fallback picked that turn, and a turn with an error never draws Thinking.

The row reads the same `isBusy` value as Stop, with no extra gate. An errored reply
finishes its turn when choosing the working turn. When the working turn cannot draw
its row (no id, suppressed, or an unretried error), the fallback row draws above
any queued bubbles. The boot shell's first prompt draws the row while it is busy.

Enforcement: `working-turn.test.ts` (aborted reply, fallback hand-off),
`session-chat-busy-row-fallback.test.ts` (one busy value), and journey 27's
`expectThinkingMatchesStop` at every queue checkpoint.
