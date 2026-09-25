---
recorded: 2026-08-24T07:13:21Z
incident_date: 2026-08-24
commit: f47184e4e0
---
# Fence provider-status caches against lifecycle mutations

**When:** caching a confirmed provider `running` result. Capture a lifecycle
generation before the provider read. Cache the result only if that generation
is unchanged. Invalidate before and after start, stop, and remove operations.
An in-flight status read can otherwise finish after a stop and resurrect stale
`running` state. *Near-miss:* the SampleCo `/start` latency optimization added
an E2B cache that could hide a completed pause for 1.5 seconds.
*Enforcer:* `e2b.test.ts` holds `getInfo()` across `stop()` and rejects revival.
