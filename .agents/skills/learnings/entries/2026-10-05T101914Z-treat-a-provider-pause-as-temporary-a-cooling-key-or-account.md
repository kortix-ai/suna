---
recorded: 2026-10-05T10:19:14Z
incident_date: 2026-10-05
---
# Treat a provider pause as temporary: a cooling key or account stays servable, and it rests until the provider's own reset time

**Rule:** A servability check (`isModelServableForAccount`) answers "is this model configured for the caller", not "can it answer this second". A `provider_pool_rate_limited` refusal counts as servable. When a provider names a reset time (ChatGPT `usage_limit_reached` carries `resets_in_seconds` / `resets_at`), the pooled key or account rests until that time, not for a fixed 30 s. The `retry-after` sent to OpenCode stays at most 60 s, because OpenCode waits out a header verbatim.

**Trigger surface:** Adding a `GatewayResolutionError` code, changing what `isModelServableForAccount` returns, changing a cooldown (`coolDownAccountSecret`, `/internal/gateway/pool-rate-limit`, `notePoolRateLimit` in `dispatch.ts`), or adding a caller that degrades a default or refuses a session on "not servable".

**Incident:** 2026-10-05, prod v0.13.50. A project's only shared ChatGPT account hit its weekly plan limit (`limit_window_minutes: 10080`, about 4.8 days left). Each 429 rested it 30 s. During every rest, `resolveDefaultModelForPrincipal` read the default as unservable and degraded it, so `resolve-route` returned `platform-default-degrade` instead of `project:default`. `startChainWithout` refused a non-project route, and the turn failed with a raw `429 provider_pool_rate_limited`, although the project had a `glm-5.3-flash` chain. The same rule refused new sessions (`INVALID_SESSION_MODEL`) and Slack/Teams turns ("model isn't available"). Outside the rests, about 400 requests per hour paid one refused ChatGPT call before the chain ran. The Slack card said "give it a minute", and the web showed the turn twice as raw JSON.

**Enforcement:** `apps/api/src/llm-gateway/resolution/default-model.test.ts` (a cooling pool is servable; the default stays the default), `packages/llm-gateway/src/pipeline/dispatch.test.ts` (a usage limit rests until its reset, client `retry-after` at most 60), `apps/api/src/llm-gateway/internal-routes.test.ts` (`/pool-rate-limit` accepts days, refuses past 8 days), and `apps/api/src/__tests__/integration-usable-gateway-secrets.test.ts` (the stored rest is kept).
