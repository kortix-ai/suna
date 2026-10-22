---
recorded: 2026-09-30T20:45:20Z
incident_date: 2026-09-30
---
# Give every provider its own credential name; never let one stored key connect two providers that share a models.dev env var

**Rule:** A provider's stored credential name comes from `providerAuthRequirement` (packages/llm-catalog/src/lite.ts), never from models.dev `env[0]` directly. When models.dev lists one env var for several providers, one owner keeps it and every other provider reads `<PROVIDER_ID>_API_KEY`. Every reader (gateway `resolveCatalogUpstream`, sandbox withholding, web form, CLI) goes through that one function.

**Trigger surface:** Adding a BYOK provider, reading a provider key by name anywhere, refreshing the models.dev catalog (a new provider can start sharing an existing env var), or adding a sign-in method that stores a credential for a provider.

**Incident:** 2026-09-30. OpenCode Zen and OpenCode Go both list `OPENCODE_API_KEY` on models.dev. Kortix stored one secret under that name, so a Zen key listed Go models and a Go key listed Zen models. The same happened for 11 env vars across 30 providers (Z.ai vs Zhipu, regional MiniMax/Moonshot/Alibaba endpoints). In prod, 44 projects held `OPENCODE_API_KEY`; 17 had succeeded only on Go, 0 on Zen. Fixed by the per-provider name rule plus migration 20260930220000000_provider_own_key_names, which copied the shared key to the provider's own name only where the project had a successful request to that provider in 120 days.

**Enforcement:** `packages/llm-catalog/src/auth-requirements.test.ts` ("no two catalog providers read the same single key"), `apps/api/src/llm-gateway/models/provider-registry.test.ts` (OpenCode Go reads `OPENCODE_GO_API_KEY`).
