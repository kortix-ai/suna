---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# Queue acceptance must not delay another prompt's first paint

A submit latch cleared later drafts but postponed their dispatch until the first
POST returned. Users saw an empty composer and no queue entry for several seconds.
Dispatch each distinct draft immediately; guard only duplicate submits from a
cleared editor. The inbox owns execution order. Track concurrent acceptances so
an out-of-order response does not release duplicate protection prematurely.

The working hook also omitted `pendingDelivery` from its memo identity. A turn
could become active without changing its ID or start time, leaving the sending
state cached. Include every visible projection field in the memo identity.

Enforced by `composer/submit-latch.test.ts`, SDK
`react/session-queue-transitions.test.ts`, and the held-acceptance browser case in
`tests/e2e/specs/27-desktop-parity.spec.ts`.
