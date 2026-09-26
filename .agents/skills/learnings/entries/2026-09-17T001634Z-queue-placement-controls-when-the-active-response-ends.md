---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# Queue placement controls when the active response ends

The inbox treated Quick Queue and Queue List as presentation variants. Quick
Queue could not stop a long response, while Queue List and Quick Queue both
waited for natural completion. Keep both placements behind the same durable
FIFO admission gate. Only the FIFO head with `placement: transcript` may arm a
signed daemon interrupt. The daemon must identify the active root message and
wait until its running tool finishes before aborting that response. Queue List
must never arm this interrupt. A removed prompt or explicit Stop disarms it.

Enforcement: `inbox-admission.test.ts`, `queued-continue-inbox-delivery.test.ts`,
`quick-queue-control.test.ts`, and daemon `quick-queue-interrupt.test.ts` and
`abort-after-tool.test.ts`.
