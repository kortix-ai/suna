---
recorded: 2026-11-04T20:26:31Z
incident_date: 2026-11-03
---
# An ask never holds a session: park it after a short live window and keep it in Review

**Rule:** A tool call that waits on a person (the `question` tool, a permission `ask`, any future human gate) waits for a live answer for a bounded window only (`live_wait_ms` from apps/api: 3 minutes, 0 for a trigger, unattended or worker session). Then it PARKS: the call returns, the turn goes on, and the ask stays open in apps/api (`session_pending_questions` with `parkable`, `session_pending_permissions`) until a person decides it in Review or the session. Any new message, synthetic or not, parks every open ask, and the prompt inbox parks them when a queued row waits behind such a turn (`POST /kortix/runtime/asks/park`). A decision reaches the agent as a new message. A permission approved while parked is consumed by exactly one re-run of the same call (`args_hash`). Never dismiss an ask to free a session: dismissal loses it.

**Trigger surface:** A tool or gate that waits for a person in any harness; an inbox admission rule that refuses a row because a turn is active; a session nobody watches (triggers, Spaces workers, coordinator workers).

**Incident:** Reported 2026-11-03 and 2026-11-04: a session's queue (peer messages, background-subagent notices, the person's follow-ups) stalled behind one unanswered question, and permission asks blocked entirely. The question dismissal from 2026-10-14 freed a session only for a non-synthetic message, never for a permission ask, and lost the question it dismissed. Permission asks had no durable record, so Review and "Needs you" never showed them.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` ('a synthetic steer … parks an open question', 'POST /kortix/runtime/asks/park …', 'a new prompt parks a permission ask …', 'a call a person approved while it was parked runs on the re-run …'); `apps/api/src/__tests__/integration-session-asks.test.ts`; REST flow `SESS-63`.
