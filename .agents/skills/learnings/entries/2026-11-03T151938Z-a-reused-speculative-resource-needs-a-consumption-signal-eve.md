---
recorded: 2026-11-03T15:19:38Z
incident_date: 2026-11-03
supersedes: 2026-08-17T084017Z-a-reused-speculative-resource-needs-a-consumption-signal-eve.md
---
# A reused speculative resource needs a consumption signal every holder can see (warm sessions removed, enforcers retired)

**Rule:** Unchanged for any future pre-provisioned handle: when several holders
(tabs, browsers, devices) can hold the same server-side find-or-create
resource, consult a synchronous cross-holder record at take time, record every
take and every navigation into it, and revalidate a held copy when the holder
regains focus.

**Trigger surface:** Adding any client-side cache of a speculative server
resource (a pre-created session, a pre-booted box, a reserved slot).

**Incident:** Not an incident. Warm sessions were removed on 2026-11-03: a
session boots fast enough on its own, and 66 % of the pre-created sessions
were never used. The warm ready-store this rule was written for is deleted.

**Enforcement:** Retired with the code. `warm-session-taken-registry.test.ts`,
`use-warm-project-session.test.ts` and the warm half of SESS-18 are deleted.
SESS-18 now pins the removal: `POST /sessions/warm` and `/warm/claim` answer
`410 ENDPOINT_RETIRED`. A new speculative resource needs its own enforcer.
