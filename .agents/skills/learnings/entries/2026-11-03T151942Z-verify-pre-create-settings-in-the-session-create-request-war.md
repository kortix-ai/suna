---
recorded: 2026-11-03T15:19:42Z
incident_date: 2026-11-03
supersedes: 2026-09-16T215041Z-verify-pre-create-settings-in-the-session-create-request.md
---
# Verify pre-create settings in the session create request (warm-session enforcer retired)

**Rule:** Unchanged: a setting the new-session composer must carry into
`POST /sessions` lives in composer-owned state. Assert the outgoing create body
and the session read-back after the visible control changes. Every send from
the composer is now an ordinary create; no path skips the create body.

**Trigger surface:** Adding a setting that the new-session composer sends at
create time (agent, model, sandbox template, provider keys, connector bindings).

**Incident:** Not an incident. Warm sessions were removed on 2026-11-03, and
with them the warm-session unit test that rejected a create body with
`provider_secret_pools`.

**Enforcement:** Partial. `tests/src/flows/secrets.flow.ts` (SEC-POOL) refuses
`POST /sessions` with an ungranted `provider_secret_pools` key (`403`). No
browser journey asserts the composer's create body for provider keys
(`rg provider_secret_pools tests/e2e` finds nothing on 2026-11-03): add one
with the next change to that panel.
