---
recorded: 2026-09-30T12:36:13Z
incident_date: 2026-09-30
---
# Never accept over HTTP a prompt or a warm session that the instance-scoped drain will refuse

**Rule:** An HTTP route that turns a request into a `session_lifecycle_commands`
row must apply the same ownership predicate as `claimDueLifecycleCommands`
before it answers 2xx. When `KORTIX_INSTANCE_ID` is set and the session's
sandbox carries another instance's id, refuse the request. Do not store the row.
A route that offers a session for later use (the warm lookup) applies the same
predicate to what it offers.

**Trigger surface:** Adding or changing a route that enqueues a lifecycle
command for an existing session, or a lookup that hands a session to a client.
Changing `apps/api/src/services/sessions/instance-scope.ts` or the claim predicate in
`session-lifecycle/command-claims.ts`. Running more than one local API stack on
the shared database.

**Incident:** 2026-09-30, local development. Instance scoping leaves HTTP-path
work unscoped and scopes background work. `findWarmProjectSession` and
`POST .../sessions/:id/prompts` sat on the unscoped side and wrote rows for the
scoped side. The primary API offered a warm session that a stopped worktree API
had provisioned the day before, accepted the first prompt with 200, and stored
it as a `continue_session` command. The claim predicate excluded the row on
every pass: the inline kick, the 1 s worker and the 10-minute starvation
reconciler. The row stayed `queued` with `attempts = 0`, `GET .../prompts`
reported it `queued` with `reason: null`, and web and mobile both waited on a
turn that never started. The box reaper also skips foreign sandboxes, so the
warm row kept its marker and the lookup kept offering it. At the time of the
diagnosis 92 commands in the shared local database were in this state, 56 of
them ordinary follow-up prompts. Deployed dev, staging and prod do not set
`KORTIX_INSTANCE_ID` in the repo; previews set it with one id per database.

**Enforcement:**
`apps/api/src/__tests__/integration-instance-scope-prompt-accept-http.test.ts`
drives both accept routes over HTTP: a prompt for another instance's sandbox
returns `409 SESSION_OWNED_BY_OTHER_INSTANCE` and stores no row, and a claim on
another instance's warm session returns `409` and leaves the marker.
`apps/api/src/__tests__/integration-warm-sessions-exclude.test.ts` pins the
lookup predicate, including the no-op when no instance id is set. None yet for
the other enqueue sites (connector approval decisions, reminders): a command
they write for a foreign sandbox still waits for its owner with no expiry.
