---
recorded: 2026-11-03T15:19:43Z
incident_date: 2026-11-03
supersedes: 2026-09-30T123613Z-never-accept-over-http-a-prompt-or-a-warm-session-that-the-i.md
---
# Never accept over HTTP a prompt that the instance-scoped drain will refuse

**Rule:** An HTTP route that turns a request into a `session_lifecycle_commands`
row applies the same ownership predicate as `claimDueLifecycleCommands` before
it answers 2xx. When `KORTIX_INSTANCE_ID` is set and the session's sandbox
carries another instance's id, refuse the request and store no row. A route
that hands an existing session to a client for later use applies the same
predicate to what it hands out.

**Trigger surface:** Adding or changing a route that enqueues a lifecycle
command for an existing session. Changing `apps/api/src/projects/instance-scope.ts`
or the claim predicate in `session-lifecycle/command-claims.ts`.

**Incident:** Not an incident. Warm sessions were removed on 2026-11-03, so the
warm lookup and the warm claim, two of the routes the superseded entry named,
no longer exist.

**Enforcement:**
`apps/api/src/__tests__/integration-instance-scope-prompt-accept-http.test.ts`:
a prompt for another instance's sandbox returns
`409 SESSION_OWNED_BY_OTHER_INSTANCE` and stores no row.
`integration-warm-sessions-exclude.test.ts` is deleted. Still none for the
other enqueue sites (connector approval decisions, reminders).
