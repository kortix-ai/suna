---
recorded: 2026-09-02T15:59:17Z
incident_date: 2026-09-02
commit: 1ca6d528e7
---
# A read that fails is not an admin decision — health flags fail open

**When:** writing any code path that answers "is the platform in maintenance /
locked down / degraded?", especially one an edge proxy polls.
`getEdgeMaintenanceConfig()` returned a synthetic `level: 'blocking'` whenever
the Vercel Edge Config read threw *or the key was simply absent*. The
`api-router` worker polls that route as `MAINTENANCE_STATE_URL` and answers
every non-read-only request to `api.kortix.com` with a 503 carrying that
config's `message`. So one failed network call locked production writes, and
users got `ApiError: Kortix is temporarily unavailable. Service will resume
automatically.` — the string that only that fallback produces. Nobody had
touched the admin toggle. **The rule:** an unknown state is `none`. Distinguish
"the store says nothing" (normal operation) from "the read failed" (serve the
last value actually read, else normal operation). A lockdown that must survive
the flag store being down belongs in the consumer as an explicit override
(`MAINTENANCE_LEVEL_OVERRIDE` on the worker), never as a failure default.
Commit 005fd6a4c9 fixed three of these paths on 2026-08-02 and missed the
fourth and fifth — when you flip one fail-closed path, grep for every producer
of the same message. *Incident:* prod, Better Stack `Kortix Frontend`: 1,000+
`ApiError` occurrences over ~2 days; the client-side twin
(`automaticMaintenanceConfig()`) additionally navigated users off a healthy app
to `/maintenance` on one failed poll. Enforcement:
`maintenance-store.test.ts` edge-gate cases, `maintenance-client.test.ts`
"stays out of maintenance after a status request failure".
