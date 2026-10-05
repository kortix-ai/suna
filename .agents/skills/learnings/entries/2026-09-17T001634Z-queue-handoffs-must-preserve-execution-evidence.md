---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# Queue handoffs must preserve execution evidence

A worker claim is not delivery. Mapping every running inbox row to Sending made
waiting prompts flash Sending on each admission retry. Stamp delivery only after
admission succeeds and clear that evidence on the next claim.

A terminal relay can inspect the queue while its head is claimed. Recheck turn
authority after an admission refusal is requeued; if the turn ended, promote and
drain the head immediately. Completion wakes must skip the new-submission burst
delay. Exact terminal recovery must also wake the queue after clearing authority;
a read cooldown must not suppress the completion read. Never promote on accepted
delivery while the previous response is active.

Runtime activity must preserve the confirmed active message ID. An older inbox
snapshot cannot keep that same turn pending after execution starts.

Enforcement: `session-prompt-view.test.ts`, `queued-continue-inbox-delivery.test.ts`,
`integration-prompt-inbox.test.ts`, SDK `working.test.ts`, and
`session-chat-busy-row-fallback.test.ts`.
