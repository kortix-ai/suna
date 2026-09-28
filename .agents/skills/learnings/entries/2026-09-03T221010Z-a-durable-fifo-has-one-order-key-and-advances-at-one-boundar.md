---
recorded: 2026-09-03T22:10:10Z
incident_date: 2026-09-03
commit: 0c02b69013
---
# A durable FIFO has one order key and advances at one boundary

**When:** implementing a queue whose enqueue requests can race. Define one total
order and reuse it for listing, admission, claims, repair, and promotion. Never
mix client send time with database insert time. Promote the next item only after
the current turn closes; delivery-time promotion races terminal promotion and
loses the wake. *Incident:* queued prompts reversed after hydration, and the
next prompt paused up to the 2-second admission backoff. *Enforcer:*
`inbox-order.test.ts`, `integration-prompt-inbox.test.ts`, and
`queued-continue-inbox-delivery.test.ts`.
