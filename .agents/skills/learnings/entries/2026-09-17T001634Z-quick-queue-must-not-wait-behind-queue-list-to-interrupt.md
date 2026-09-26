---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# Quick Queue must not wait behind Queue List to interrupt

A local session had an older Queue List entry and a newer Quick Queue entry
waiting on one active response. Admission armed the tool-boundary interrupt
only for the FIFO head, and the head was the Queue List entry. The Quick Queue
entry recorded 72 `turn_active` refusals while the response kept working.

Quick Queue is a lane ahead of Queue List. The inbox order key is
`(lane, clientSentAtMs, wireMessageId, commandId)`, with lane 1 only for an
explicit `placement: 'composer'`. A first prompt, an automation row, or an older
producer has no placement and keeps its send-order place ahead of Queue List.
Every listing, admission, batch, strand repair, promotion, and claim uses this key.

Enforcement: `inbox-order.test.ts` covers lane order and rows without placement.
`integration-prompt-inbox.test.ts` proves listing, interrupt arming, refusal of
the older Queue List row, and terminal promotion against real PostgreSQL.
