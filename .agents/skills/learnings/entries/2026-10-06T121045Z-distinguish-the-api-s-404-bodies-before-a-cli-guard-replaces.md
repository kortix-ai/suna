---
recorded: 2026-10-06T12:10:45Z
incident_date: 2026-10-06
commit: 0809b9ae8c
---
# Distinguish the API's 404 bodies before a CLI guard replaces one: a session miss and a bad resource id both 404, and a hint keyed on status alone lies

**Rule:** Before a CLI command rewrites a 404 into friendlier text, enumerate every
404 body the touched routes return and key the rewrite on the exact body
(`body.error === 'Not found'`), never on the status alone. One route family can
answer `{"error":"Not found"}` (session or project not visible) and
`{"error":"Reminder not found"}` (typo'd id on PATCH/DELETE) with the same status.

**Trigger surface:** Any `catch` in `apps/cli/src/commands/*` that replaces a
`surfaceApiError` message for one status code, and any new message that names a
cause the API did not state.

**Incident:** 2026-10-06, PR #9219 (KRTX-1686, the `remind-session-reminder`
dogfood journey). `kortix reminders` used `$KORTIX_SESSION_ID` implicitly; against
a project on another host the API 404'd and the CLI printed a bare `Not found`
that reads like a platform failure. The first fix keyed the new hint on
`status === 404`, which would have told a user with a typo'd reminder id to "pass
--session" — a hint that cannot fix their problem. The independent review caught
it before merge; the shipped guard matches the session-miss body exactly and a
characterization test pins `reminders pause <bad-id>` to the server's own text.

**Enforcement:** `apps/cli/src/__tests__/reminders-live.test.ts` — "a 404 from a
bad reminder id keeps the server text, not the session hint" (the stub route
returns the real API's `Reminder not found` body) runs in the package suite.
