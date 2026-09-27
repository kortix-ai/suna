---
recorded: 2026-08-24T07:13:21Z
incident_date: 2026-08-24
commit: f47184e4e0
---
# A deliberate runtime failure park must require explicit restart

**When:** returning a stopped sandbox after `runtime_boot_failed` or
`runtime_wake_failed`. Do not classify that row as an ordinary hibernated
sandbox. Automatic `/start` retries can otherwise resume the same broken runtime
and repeat the full readiness timeout forever. *Incident:* an SampleCo E2B
session issued consecutive 9.6–10.2 second `/start` calls for over 80 seconds;
the existing 5-minute server window then parked and auto-resumed the same box.
*Enforcer:* API repeated-start and web resumability regression tests.
