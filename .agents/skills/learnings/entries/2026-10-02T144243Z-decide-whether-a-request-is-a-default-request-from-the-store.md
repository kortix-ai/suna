---
recorded: 2026-10-02T14:42:43Z
incident_date: 2026-10-02
---
# Decide whether a request is a default request from the stored defaults, not from the one default the gateway can serve now

**Rule:** A project's Routing chain applies to a request for a configured
default. Decide that from the defaults as stored: the project default (else the
account default, else the platform default) and the default of the session's
agent. Never decide it from `principal.defaultModel` alone. That field holds one
model, the most specific default the gateway can serve at authentication, so it
names another model when the agent has its own default, and no model when every
account of the default's provider is paused. Both cases are when the chain is
needed.

**Trigger surface:** Changing how the gateway classifies a request as "the
default" (`createGatewayRouteResolver` in
`apps/api/src/llm-gateway/routing/resolve-route.ts`), changing default-model
resolution or its servability degrade (`resolution/default-model.ts`), adding a
scope of model default, or writing Routing screen copy that says which models a
chain covers.

**Incident:** 2026-10-02, production. Hourly triggers pinned to the project
default ran on an agent that had its own default. The ChatGPT plan reached its
weekly usage limit. The gateway routed each request `direct` with no fallback
models, so the raw `429 usage_limit_reached` reached the session and the
project's two-model chain on `any-error` never ran. In 50 consecutive request
logs, 36 session requests failed after one attempt (20 with 429, 16 with 401),
while 2 requests through a gateway API key fell back. The Routing screen stated
"every model uses the fallback above", and the preview route reported the chain
as active, because it built its principal from the project default. Blast
radius: every project with a default chain and an agent default that differs
from the project default, and every default chain during a full provider pause.
No data loss.

**Enforcement:**
`apps/api/src/llm-gateway/routing/default-route.integration.test.ts` (real
PostgreSQL: stored defaults, session agent, routing policy row; 2 of 4 tests
fail when `isConfiguredDefault` is not wired), `resolve-route.test.ts` ("a
configured default takes the project chain when the principal default is another
model"), and `resolution/default-model.test.ts` ("isConfiguredDefaultModel — the
defaults as stored, not as served").
