---
recorded: 2026-09-24T18:46:19Z
incident_date: 2026-09-24
commit: 881d56eb99
---
# A position id minted by a copied formula drifts silently; every producer uses the one minter

**Incident.** A prod session showed "Thinking" forever. The agent was working,
but its replies rendered in a turn drawn above two older prompts. Those prompts
came from `kortix sessions chat --queue`, whose `wireMessageId()` copied the
SDK's `ascendingId` formula: the HIGH 12 hex digits of `Date.now() * 0x1000`.
OpenCode keeps the LOW 48 bits. CLI ids were about 40 days ahead (`msg_1a0d…`
against `msg_0d4…`). Every host orders placed messages by id, so each later turn
sorted above them. The server let them through: `POST /prompts` checks shape
only, a first delivery keeps the client id, and proxy repair re-mints only ids
that are too low. 104 prod turns in 59 sessions across 4 accounts, from
2026-09-16. 101 of the 104 matched a CLI POST.

**Rules.**
1. An id that encodes an ordering position is minted by ONE function. Do not
   copy the formula. The SDK exports `mintWireMessageId`; the CLI imports it.
2. A client that cannot read the transcript sends `remint_on_delivery: true`.
   Only the process that holds the transcript places the id.
3. A placement check rejects ids that are too far AHEAD, not only too low. A
   floor or lift ignores any id more than 1 h past the clock (`isWireIdAheadOf`),
   including the SQL floor, so one bad row cannot hide the real floor.
4. A header that lets a caller skip a check (`X-Kortix-Wire-Id-Placed`) skips
   only the expensive read. The pure check still runs.
5. Display order trusts an id only while it agrees with its own `time.created`
   (±1 h). Otherwise it falls back to the server's order (`time_created`, then
   id). This also fixes sessions that span the 48-bit wrap on 2026-08-14.

**Enforcement.** `tests/spec/wire-message-id.vectors.json` (API and SDK);
`packages/sdk/src/core/turns/display-order.test.ts` (prod-shaped ids, the
wrap); `apps/cli/src/commands/sessions-queue.test.ts`; API tests for POST
stamping, drain floors, and proxy repair (`sandbox-proxy/routes/forward.test.ts`).
PR #7597.
