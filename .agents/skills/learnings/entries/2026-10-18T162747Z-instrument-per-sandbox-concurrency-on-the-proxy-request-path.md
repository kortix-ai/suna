---
recorded: 2026-10-18T16:27:47Z
incident_date: 2026-10-18
---
# Instrument per-sandbox concurrency on the proxy request path, not just per-request latency

**Rule:** When a proxied route's latency rises, instrument per-TARGET concurrency before touching routing or retries: a herd of concurrent reads to one sandbox reads in the request log as N unrelated slow rows. Stamp a per-sandbox in-flight counter at proxy entry (counted with self, after auth, before the rate limit) so a herd is one aggregate query, not a hand rebuild from completion timestamps.

**Trigger surface:** `apps/api/src/sandbox-proxy/*` — any request-log field or latency investigation on `/v1/p/:sandboxId/:port/*` (file/raw, preview, daemon hops).

**Incident:** 2026-10-10 and 2026-10-16 (KRTX-471, PR #10228). Two p95 spikes on the proxy route were herds to a single sandbox (one client, 649 concurrent `/file/raw` reads; later six concurrent reads to one degraded box, every row a 200). The SDK-side read limiter (PR #9516) only sees the web client, so agents, scripts and mobile stayed unbounded and invisible. Diagnosis cost days of completion-timestamp reconstruction.

**Enforcement:** `apps/api/src/sandbox-proxy/sandbox-inflight.test.ts` — red without the gate (the stamp disappears from the request log). The dashboard query is `max(sandbox_inflight) GROUP BY sandbox, minute` on the request log.
