---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# Thinking follows the prompt being delivered

With the previous answer finished and the next Quick Queue prompt mid-delivery
(`delivery_started_at` set, 9 attachments, no turn yet), Thinking sat under the
finished answer, above the prompt the agent was about to run. A prompt whose inbox
state is `delivering` is the work in progress: the fallback row renders directly
under its bubble, and a finished answer above it yields its own row.

Enforcement: `working-turn.test.ts` covers the delivering anchor and the yield.
