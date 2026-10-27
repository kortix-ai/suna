---
recorded: 2026-10-02T15:01:58Z
incident_date: 2026-10-02
---
# Apply a project's fallback chain to every model, never only to the model the gateway resolved as the default

**Rule:** A project's Routing chain is a catch-all. It covers every model that
has no exact-model override. Never gate it on "is this request the default".
The gateway knows the default as `principal.defaultModel`: one model, the most
specific default it can serve at authentication. That value names the agent's
model when the agent has its own default, and nothing when every account of the
default's provider is paused. Both cases are when the chain is needed. Keep the
screen, the docs and the resolver on the same sentence: a rule the UI states and
the gateway does not apply is an outage with a green settings page.

**Trigger surface:** Changing `createGatewayRouteResolver`
(`apps/api/src/llm-gateway/routing/resolve-route.ts`), changing default-model
resolution or its servability degrade (`resolution/default-model.ts`), adding a
scope of model default, or writing Routing screen or docs copy that says which
models a chain covers.

**Incident:** 2026-10-02, production. Hourly triggers pinned to the project
default ran on an agent that had its own default. The ChatGPT plan reached its
weekly usage limit. The gateway routed each request `direct` with no fallback
models, so the raw `429 usage_limit_reached` reached the session and the
project's two-model chain on `any-error` never ran. In 50 consecutive request
logs, 36 session requests failed after one attempt (20 with 429, 16 with 401),
while 2 requests through a gateway API key fell back. The Routing screen stated
"every model uses the fallback above", the docs stated the chain runs when a
BYOK key or ChatGPT plan fails, and the preview route reported the chain as
active. Blast radius: every project with a chain and a request for any model
other than the principal's resolved default, and every chain during a full
provider pause. No data loss.

**Enforcement:** `apps/api/src/llm-gateway/routing/resolve-route.test.ts` ("a
session on an agent with its own default takes the project chain for any
model", "project exact rules override the project chain, and the chain covers
every other model", "\"No fallback\" covers every model, and a project with no
chain keeps the platform route") and flow `GW-4` in
`tests/src/flows/llm-gateway.flow.ts` ("the project chain covers a model that is
not the default and has no override").
