---
recorded: 2026-11-06T14:34:15Z
incident_date: 2026-11-02
---
# Bound a model request by its bytes, not only its tokens and image count

**Rule:** Bound every model request by its body bytes as well as its tokens and its image count. Treat a provider's "too long" refusal of a large body as a size problem: compacting the text does not fix it, because compaction keeps the newest images.

**Trigger surface:** Changing the gateway image window (`packages/llm-gateway/src/pipeline/image-window.ts`), upstream error classification (`pipeline/error-response.ts`, `public-identity.ts`), pi's model limits (`apps/kortix-sandbox-agent-server/src/harness/pi/model.ts` `IMAGE_RESIZE`), or adding a provider with a lower request cap.

**Incident:** 2026-11-02, self-host on v0.14.19. An enterprise pi session on Bedrock Opus 5.5 read 1600x1200 aerial PNGs (2.6-3.1 MB, 3.6 MB as base64) four per step. pi kept them as PNG (under its 4.5 MB default), the gateway kept 12 (count cap only): 40 MB. Bedrock refuses a body over ~32 MB with "Input is too long for requested model." at ~22k tokens (probed 2026-11-06: 31,262,126 B → 200, 32,029,742 B → 400). pi compacted twice, retried twice, and stopped the turn after 104 min. The gateway logged only "upstream HTTP 400".

**Enforcement:** `packages/llm-gateway/src/pipeline/image-window.test.ts` (the 43 MB request leaves at most 22 MiB of images; the byte cut holds the cache prefix), `simple-handler.test.ts` (a 43 MB request reaches the provider under 31 MB; a "too long" refusal of a body over 30 MB is `request_too_large`; the trace keeps the provider text), `apps/kortix-sandbox-agent-server/src/__tests__/pi-model-limits.test.ts` (pi's read tool sends a 1600x1200 photo PNG as a JPEG under 1.5 MB).
