---
recorded: 2026-09-21T12:44:34Z
incident_date: 2026-09-21
commit: 4a1497bccd
---
# A turn that died must say why; a stop somebody asked for is the only silent ending, and it is recorded where it is asked for

**Rule.** When a runtime reports why a turn ended, persist the reason on the
turn's ledger row, return it from `GET .../turn`, and render it under the turn.
Treat an abort as the EFFECT of a stop, never its cause: record every
intentional stop at the one place the request passes through the control plane
(the sandbox proxy for a client abort, the arm call for a queue interrupt), and
let a named cause always replace a request or a bare abort. Never derive
"the user pressed Stop" from a client-side tag or from a call that is merely
adjacent to the abort (the inbox hold): the tag dies on the next
`message.updated`, and the adjacent call can time out or be skipped.

**Incident.** Session ad02e053, 2026-09-18: the daemon's memory guard aborted
two turns at 97 % box memory and reported `SandboxMemoryGuard`. `apps/api`
dropped the frame twice — no `turn_message_id` (`identity_mismatch`) and
`error_retryable: true` (`non_terminal`) — and had no column for the reason.
The user saw four failed sub-agent tasks and no error. Dev only. Two near
misses on the fix: marking the stop on `POST /prompts/hold` would have shown a
false "stopped before it finished" under every Quick Queue interrupt and every
mobile/SDK/question-reject abort, and listing every `failed` row would have
flagged every turn anyone had ever stopped before the deploy.

**Enforcer.** `apps/api/src/__tests__/integration-sandbox-turn-lifecycle.test.ts`
(real PostgreSQL) pins the ledger rule and was mutation-checked; `SESS-34` pins
the `/turn` contract; `apps/kortix-sandbox-agent-server`
`memory-guard-turn-end.test.ts` drives the real guard against a stubbed API and
fails on a missing `turn_message_id` or a retryable frame. PR #7449.
