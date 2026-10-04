---
recorded: 2026-09-27T03:29:51Z
incident_date: 2026-09-27
---
# An 'unattended session' predicate must check spawned_by_session, not just origin

**Rule:** When deciding "is a human waiting on this session" for an
auto-recovery, auto-continue, or notification-suppression decision, check
BOTH `project_sessions.origin IN ('trigger','schedule','system')` AND
`metadata.spawned_by_session` (set whenever a session is created with a
`callerSessionId` — a worker/sub-agent task another session spawned).
`resolveSessionOrigin` resolves ANY in-session token to `origin: 'user'`
unconditionally (the security-critical exclusion that keeps the connector PAT
from resolving `backend`), so a spawned worker session is `origin: 'user'`
even though nobody is looking at it. An origin-only check misses exactly the
"software factory worker" population.

**Trigger surface:** any policy gate that must distinguish an attended
session (a human has, or will, open its page) from an unattended one (a
trigger run, a cron, or a worker/sub-agent task) — auto-restart, auto-resume,
default notification routing, or anything else keyed on "will someone come
back to release this".

**Incident:** none yet — found while implementing bounded, idempotent
auto-recovery for sessions whose sandbox died mid-turn
(`runtime_gone`/class-B census, 2026-09-27). The existing `UNATTENDED_ORIGINS`
set in `apps/api/src/projects/lib/on-behalf-of.ts` already encodes this
distinction for a DIFFERENT purpose (whose personal resources an agent may
reach) and does not cover spawned workers either, because `on_behalf_of` is
inherited from `parentOnBehalfOf` for a spawned child, not derived from origin
alone. `isUnattendedSession` in `unattended-runtime-recovery.ts` is the first
place this exact two-part predicate is written down for a RECOVERY decision.

**Enforcement:** `apps/api/src/services/sessions/lifecycle/unattended-runtime-recovery.test.ts`
— "a worker/sub-agent session is unattended even though its origin is `user`"
pins the `spawned_by_session` half; "a human session, or a KaaB backend
session, is attended" pins that `backend` origin stays attended (the remote
end-user is a system Kortix cannot observe, so it keeps the human-attended
default rather than guess).
