---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# Queue recovery cannot depend on a live daemon subscription

A local session subscribed to daemon events five minutes after boot. Thirteen
prompts reached the runtime in order, but periodic reconciliation added up to
16 seconds after each reply. The queue head must verify exact active-turn
completion when the relay is missing. Clear only the observed token, only on
`completed` or `failed` evidence. Unknown, active, and unanswered prompts keep
authority. Never forward another prompt into the active turn.

Client-minted wire IDs do not prove delivery. Group pending transcript entries
after delivered turns using durable inbox order. Otherwise a re-minted active
prompt jumps below older-looking waiting entries.

Enforcement: `inbox-turn-recovery.test.ts`, `inbox-admission.test.ts`, and SDK
`display-order.test.ts` cover terminal recovery, refusal, and display order.

Prompt delivery retries must run independently of singleton cron leadership.
With shared local databases, the elected API rejected another worktree's rows,
while the owning API ran no retry worker. Filter ownership before claiming and
keep the existing claim CAS. `worker.test.ts` covers retry startup without
leadership, restart, shutdown, and explicitly disabled background work.
