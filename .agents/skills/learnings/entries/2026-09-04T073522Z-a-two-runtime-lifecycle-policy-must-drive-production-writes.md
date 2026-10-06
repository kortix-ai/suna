---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# A two-runtime lifecycle policy must drive production writes

**When:** adding an auxiliary runtime whose lifecycle follows a session worker.
**Incident:** the worker/environment state matrix existed only in tests, while `ensure` could
provision compute for a parked worker and stop paths closed rows and meters after an unconfirmed
provider failure.
**Rule:** consume the shared state matrix in every ensure and reaper path. Do not report success,
close metering, or mark the auxiliary runtime stopped until provider state confirms the stop.
**Enforcer:** lifecycle ensure, teardown, route, reaper, and manual-stop tests cover every pair and
provider failure outcome.
