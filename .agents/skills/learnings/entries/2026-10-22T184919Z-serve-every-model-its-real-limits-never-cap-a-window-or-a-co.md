---
recorded: 2026-10-22T18:49:19Z
incident_date: 2026-10-22
---
# Serve every model its real limits; never cap a window or a compaction point with a Kortix default

**Rule:** A model's context window and output limit come from its source: models.dev for BYOK, Platinum for managed models, Codex `models.json` for ChatGPT models, and the endpoint's `GET /models` for a custom endpoint. Pass each field through as reported. Leave an unknown field unset; never fill it with a Kortix number that then reads as data. pi compacts at its own default (window minus its reserve); there is no Kortix compaction budget. The harnesses read the live `GET /models?scope=picker` catalog, not only the image-baked file. A default stays only where no source exists: OpenCode's window for a model nothing can size (it never compacts without one), pi's 128k for the same case, and OpenCode's 65,536 output cap (OpenCode does not clamp `max_tokens` to the room left in the window).

**Trigger surface:** `apps/api/src/llm-gateway/models/catalog-models.ts` (`servedLimit`), `llm-gateway/custom-providers.ts`, `models/codex-models.ts`, `apps/kortix-sandbox-agent-server/src/harness/pi/model.ts`, `harness/open-code/lifecycle.ts` (`withModelLimits`), `packages/ui/src/session/composer/context-usage.ts`, or any new provider family.

**Incident:** 2026-10-22. A 1M-token custom endpoint model showed "128k window" in the composer and compacted at ~92k used, because the gateway served every custom model a hard-coded 128k/16k. pi also capped every session at a 160k compaction budget (#9245) and sized custom and Platinum BYOK models from the baked catalog at 128k. Codex models served the public API window (~1.05M) instead of the ChatGPT backend's 272k. This supersedes the 2026-10-06 rule "Compact a pi session at a token budget": cost is controlled per project, not by cutting every model's window.

**Enforcement:** `apps/api/src/llm-gateway/custom-providers.test.ts` (probe + served limits), `models/catalog-models.test.ts` "a served limit is never invented" and the Codex window case, `kortix-sandbox-agent-server/src/__tests__/pi-model-limits.test.ts` (pi reads the live picker), `opencode-catalog.test.ts` "a model keeps its own window", `packages/ui/src/session/composer/context-ring.test.ts` "an unknown window is null".
