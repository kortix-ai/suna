---
recorded: 2026-10-21T19:04:47Z
incident_date: 2026-10-21
---
# Gate any shared-credential feature per org before it ships, and stream-test it against chunked upstreams

**Rule:** A feature that spends a shared credential (our vendor API keys, our GPU) ships behind an explicit per-org allow, never behind a global flag alone. Before promoting it, check the target environment's global flags and billing mode. A streaming relay must keep reading until it enqueues something, and its test must split events across small chunks.

**Trigger surface:** Adding or promoting a Platinum route that calls third-party upstreams (`/v1/inference` named models), or any proxy that rewrites an SSE stream with a `ReadableStream` `pull()`.

**Incident:** 2026-10-21. Two problems after Platinum `8b01181c2` (kortix-ai/platinum#1823) reached prod:
1. **Cost leak, about 1 h.** `flags.inference_enabled` was already `true` on Platinum prod and `billing.mode` was `shadow`, so any Platinum org could call DeepSeek/GLM on Kortix's Morph/Zen/OpenRouter keys for free.
   - Closed at once by setting the flag to false. The Kortix orgs kept working through their `inference: true` override.
   - Fixed in code by #1831: named models need the explicit per-org override.
2. **Stream stall.** Prod streams delivered 4–8 frames, then hung until the load balancer closed them at 60 s.
   - `relayStream`'s `pull()` returned without enqueuing when a chunk ended mid-event, and a pull that enqueues nothing is not called again.
   - Dev passed only because its upstream sent whole events per chunk. Fixed in #1830.
   - Separately, `/models` hung on an unreachable GPU box because the fetch had no timeout. Fixed in #1828 and #1834.

**Enforcement:** In kortix-ai/platinum `apps/api/src/api/inference.router.test.ts`:
- "an org without the inference override cannot reach the named models" (403, no upstream hit);
- "a stream whose events arrive split across many small chunks is relayed whole" (7-byte chunks; timed out before the fix);
- "/models answers within the box timeout".

`inference.live.test.ts` runs the full matrix against a deployed environment, 26 checks. Run it before every promote.
