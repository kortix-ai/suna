---
recorded: 2026-10-21T19:04:47Z
incident_date: 2026-10-21
---
# Gate any shared-credential feature per org before it ships, and stream-test it against chunked upstreams

**Rule:** A feature that spends shared paid capacity (model inference, GPU time) ships behind an explicit per-org allow, never behind a global flag alone. Before promoting it, check the target environment's global flags and billing mode. A streaming relay must keep reading until it enqueues something, and its test must split events across small chunks.

**Trigger surface:** Adding or promoting a Platinum Inference route, or any proxy that rewrites an SSE stream with a `ReadableStream` `pull()`.

**Incident:** 2026-10-21. Two problems after a Platinum Inference release reached Platinum prod:
1. **Cost leak, about 1 h.** `flags.inference_enabled` was already `true` on Platinum prod and `billing.mode` was `shadow`, so any Platinum org could call the inference models for free, on Kortix's account.
   - Closed at once by setting the flag to false. The Kortix orgs kept working through their `inference: true` override.
   - Fixed in code: inference models now need the explicit per-org override.
2. **Stream stall.** Prod streams delivered 4–8 frames, then hung until the load balancer closed them at 60 s.
   - The relay's `pull()` returned without enqueuing when a chunk ended mid-event, and a pull that enqueues nothing is not called again.
   - Dev passed only because its upstream sent whole events per chunk.
   - Separately, the model list hung on an unreachable host because a fetch had no timeout.

**Enforcement:** Platinum's inference router tests:
- an org without the inference override cannot reach the models (403, no upstream call);
- a stream whose events arrive split across many small chunks is relayed whole (7-byte chunks; timed out before the fix);
- the model list answers within its timeout.

Platinum's live inference suite runs the full matrix against a deployed environment. Run it before every promote.
