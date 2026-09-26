---
recorded: 2026-08-24T14:41:06Z
incident_date: 2026-08-24
commit: b250949eb1
---
# A stale readiness observer must claim the runtime row before stopping its provider

**When:** parking an established runtime after a failed readiness or wake probe.
CAS the exact observed `active` row, including `updated_at`, before closing
compute or calling `provider.stop()`. Never write a stale metadata object after
an external stop. Persist stop intent so a parked-row sweep retries after a
crash. *Incident:* overlapping SampleCo `/start` requests paused each new E2B
boot after about 8 seconds and erased its wake fence; OpenCode needed 11.574
seconds. *Enforcer:* runtime-identity and parked-runtime verification tests pin
the CAS and durable retry.
