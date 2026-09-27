---
recorded: 2026-09-18T11:34:29Z
incident_date: 2026-09-18
commit: 3e033a879d
---
# Decide gateway mode with one rule at boot and at prompt; a harness start failure is a `boot_error`

**Rule:** decide a box's LLM-gateway mode only with `projectLlmGatewayEnabled`,
at provision and at prompt-time env-sync alike. Enforce the plan per request in
the gateway (`principal.freeModelsOnly`), never by withholding env at boot. A
harness with no native fallback must report a failed start as `boot_error`.
**Incident:** dev, 2026-09-17 23:14 → 2026-09-18: `session-sandbox.ts` still
ANDed the 2026-06 plan gate, so pi-harness sessions of a free account booted
without `KORTIX_LLM_BASE_URL`; pi never started, health said `boot_error: null`,
the UI spun (96 boxes, 9 dead-lettered prompts). OpenCode hid the split by
switching to the gateway on the first prompt. **Enforcer:**
`session-sandbox.test.ts` (gateway env on any plan), `pi-harness.test.ts`
(failed start → `boot_error`).
