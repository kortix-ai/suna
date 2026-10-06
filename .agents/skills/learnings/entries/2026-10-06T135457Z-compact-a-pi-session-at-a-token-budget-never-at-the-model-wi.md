---
recorded: 2026-10-06T13:54:57Z
incident_date: 2026-10-06
---
# Compact a pi session at a token budget, never at the model window

**Rule:** Give pi a per-model `compaction.modelOverrides["kortix/<id>"].reserveTokens` of `window - KORTIX_PI_COMPACT_AT_TOKENS` (default 160,000). pi compacts at `window - reserveTokens`; with only its default reserve (16,384) a 1M-token model fills to ~1M before it compacts, and every request re-sends the whole context.

**Trigger surface:** pi settings in `apps/kortix-sandbox-agent-server/src/harness/pi/extensions/host.ts`, the catalog windows that `model.ts` sizes models from, or any new large-window model on the gateway.

**Incident:** 2026-10-06. The company factory project ran every session on pi and spent ~$790/day on the LLM gateway: 641k requests in 7 days, 120B input vs 0.28B output tokens, live requests averaging 122k–187k input tokens and reaching 846k. Compaction was on (#8738) but triggered only near each model's window.

**Enforcement:** `pi-harness.test.ts` "KORTIX_PI_COMPACT_AT_TOKENS compacts a context far below the model window": a 30k context on a 64k window compacts at a 20k budget and does not without it.
