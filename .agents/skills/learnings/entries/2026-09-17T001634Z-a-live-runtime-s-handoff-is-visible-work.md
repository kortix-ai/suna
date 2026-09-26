---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# A live runtime's handoff is visible work

A Quick Queue interrupt ended one turn. The next prompt's five attachments took
9.6s to reach the running runtime. Stop showed and the tinted bubble waited, but
Thinking was hidden because the projection reported pending delivery.

Pending delivery hides Thinking only while a queued status is visible and no
runtime is ready (boot, parked, unreachable). With `runtimeReady` true, a busy
session always shows Thinking, placed above the queued bubbles.

Enforcement: `working-turn.test.ts` covers the live-runtime handoff and keeps the
boot and no-runtime cases hidden.
