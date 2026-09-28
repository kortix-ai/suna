---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# A renewable grant with no absolute ceiling is an immortal resource

**When:** writing any "keep it alive while it is still working" renewal — a
sandbox deadline, a lease, a lock, a session TTL — where the thing being
observed reports its own liveness. Observation cannot distinguish WORKING from
WEDGED: both answer "still running", forever. Give every renewable grant one
wall-clock ceiling anchored on a value the observed party cannot author
(`startedAtMs`, written by the control plane at mint), set far above the real
p99 so it can only catch a record nothing will ever close.
*Incident:* `activeTurns` re-granted 4h on every reaper pass for as long as the
daemon said `active`. PROD 2026-09-10: 44 open turn records on `active`
sandboxes, 42 older than 24h, the oldest **20 days**; 33 of 48 "active" boxes
predated the week. Those boxes never stopped emitting, and their audit relays
produced **1,115,227** contended-ingest 503s in seven days — 42–68% of ALL prod
API responses — plus 62k proxy 404s and thousands of dropped Slack relays.
*Fix:* `turnAbsoluteMaxMs()` (24h), applied BEFORE the probe so neither the
renew path nor the drip can see an expired record. *Enforcer:*
`sandbox-reaper.test.ts` — a 20-day record is settled unprobed and unrenewed; a
23h record and a record with no start instant are untouched.
