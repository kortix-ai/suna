---
recorded: 2026-08-23T16:55:40Z
incident_date: 2026-08-23
commit: d3439fed46
---
# A WebSocket upgrade must obey the SAME wake policy as the HTTP path

**When:** adding or changing a gate in `resolvePreviewWsUpstream` / `ws-proxy`,
or any policy that answers a sandbox request with 503. A browser cannot see a
refused upgrade — it reports close code `1006` with no status and no reason — so
a gate the WebSocket path applies but the HTTP path does not becomes an
unrecoverable client loop, never an error the user can act on. Mirror the HTTP
resume policy, and log every refused upgrade with its status and path.
*Incident:* the session Terminal reconnected forever against an idle-parked box:
HTTP wakes it on user intent, the WS path had no wake branch at all, and the
panel's own `GET /kortix/pty` never resumes either — so a reload could not fix
it. PR #6792 adds `wake=1` for user-initiated attaches only.
*Enforcer:* `ws-wake-policy.test.ts` pins the marked/unmarked split; the
`[preview-ws] REFUSED` log makes the next one findable in one grep.
