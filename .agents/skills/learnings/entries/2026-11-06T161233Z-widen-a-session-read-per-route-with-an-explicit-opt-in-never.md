---
recorded: 2026-11-06T16:12:33Z
incident_date: 2026-11-06
---
# Widen a session read per route with an explicit opt-in, never inside the shared visibility verdict

**Rule:** `loadVisibleSession` is the gate for reads AND writes: a prompt, a
permission answer, a reminder all accept any session it returns. A new reason
to see a session (a grant, an ancestry link, a share) is an option the route
passes (`SessionReadOptions`, for example `spawnAncestorRead`), set only on routes
that change nothing. Never add it to `sessionReadAccess` unconditionally.

**Trigger surface:** editing `apps/api/src/projects/lib/session-visibility.ts`
or `agentSessionStanding` (`connectors/share.ts`); any change meant to let some
caller "read" a session it could not see before.

**Incident:** 2026-11-06, #11940 (near-miss, caught before merge). The first
commit let a subagent's session token see the sessions that spawned it, inside
the shared verdict. That also let it prompt its parent, answer the parent's
pending permission requests, and create or delete the parent's reminders. The
self-review and the Strix review both found it; `bdb8fa9` moved the rule behind
`spawnAncestorRead` on `GET …/sessions/:id` and `GET …/sessions/:id/log` only.
Live check: parent read `200`, parent `POST …/prompts` `404`, parent reminders
`403`.

**Enforcement:** `apps/api/src/__tests__/integration-session-ancestor-read.test.ts`
("a route that may change the session … never sees the parent") goes red when the
ancestor read applies without the option. None yet for a new widening: the
enforcer to build is a route test that lists every `loadVisibleSession` caller
passing an option and checks that each one is a GET or a no-op POST.
