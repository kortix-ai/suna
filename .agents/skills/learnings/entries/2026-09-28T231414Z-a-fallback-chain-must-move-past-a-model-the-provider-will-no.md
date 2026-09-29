---
recorded: 2026-09-28T23:14:14Z
incident_date: 2026-09-28
---
# A fallback chain must move past a model the provider will not serve

**Rule:** A configured fallback chain moves past every failure that means "this
upstream will not serve this model", not only rate limits. A 404 is the
provider's own "model unavailable" class (OpenAI `model_not_found`, Anthropic
`not_found_error`), so a `Retry on: transient` chain must take it, exactly as it
takes a 429 or a 5xx. The same class covers a routed model the gateway cannot
resolve at all — retired, not served by this deployment, or not recognized.

**Trigger surface:** Adding or reviewing a status list in the gateway's fallback
trigger (`LIMIT_STATUSES` in `pipeline/dispatch.ts`, `CHAIN_TAKES_OVER` in
`pipeline/simple-handler.ts`), or routing policy for a model a provider can
remove or rename.

**Incident:** 2026-09-28, production report from a workspace whose custom Routing
chain never ran. The default model's provider answered 404 for the model; the
`transient` chain did not move, and the session and the Slack bot surfaced "the
selected model isn't available" instead of the configured fallback. Blast
radius: every project with a fallback chain and a model a provider removed,
renamed, or stopped serving. No data loss. Fixed by #7979/#7983's follow-up that
adds 404 and the availability resolution codes to the fallback trigger.

**Enforcement:** `packages/llm-gateway/src/pipeline/dispatch.test.ts` ("a
transient chain moves past 404 …") and
`packages/llm-gateway/src/pipeline/simple-handler.test.ts` ("a model the
provider will not serve (404) reaches a transient chain", "a project chain takes
over an unroutable primary").
