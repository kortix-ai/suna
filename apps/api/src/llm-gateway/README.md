# llm-gateway

OpenAI-compatible LLM proxy backed by OpenRouter. Self-contained,
dependency-injected module — the host wires it up with three hooks (auth,
billing gate, usage sink) and mounts it under any path.

## Routes

| Method | Path | Notes |
|---|---|---|
| POST | `/chat/completions` | OpenAI-compatible; streams when `stream: true` |
| GET | `/models` | Proxies OpenRouter's catalog |
| GET | `/health` | Public diagnostic |

## Auth

Clients send `Authorization: Bearer <member-token>`. The gateway calls
`hooks.authenticateToken(token)` to resolve `(userId, accountId)`. Returns 401 if
the hook returns null.

## Billing gate

After auth, the gateway calls `hooks.assertBillingActive(accountId)`. A thrown
error becomes a 402 with `{ error, message, code: 'subscription_required' }` —
the host's error-handler routes that to its upgrade UI.

## BYOK

The gateway does NOT handle BYOK. BYOK is a sandbox-side concept: the user
stores their direct provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
as a project secret, it's injected into the sandbox env, and the agent
(opencode) calls the provider directly without going through this gateway.

The gateway only handles the Kortix-paid path: member token → our master
OpenRouter key → wallet debit.

## Usage accounting

After each request, `hooks.recordUsage(event)` is called once with:

- `accountId`, `actorUserId` from auth
- `provider: 'openrouter'`, `model` from the response
- `promptTokens`, `completionTokens`, `cachedTokens`
- `upstreamCost` (pre-markup, from OpenRouter's `usage.cost` when present, else
  estimated from local pricing × tokens)
- `finalCost` (= upstreamCost × `config.markup`)
- `streaming` (boolean)
- `requestId` (opaque, for tracing / dedup on the host side)

Streaming requests are passed through verbatim; usage is parsed from the final
SSE chunk (`stream_options: { include_usage: true }` is set automatically).

## Wire-up

```ts
import { createLlmGateway } from './llm-gateway';

app.route(
  '/v1/llm',
  createLlmGateway(
    {
      enabled: config.LLM_GATEWAY_ENABLED,
      openrouterApiKey: config.OPENROUTER_API_KEY,
      markup: 1.2,
    },
    {
      authenticateToken: (token) => attributeYoloToken(token),
      assertBillingActive,
      recordUsage: async (event) => {
        await deductForLlmUsage({ ... });
        await recordUsageEvent({ ... });
      },
    },
  ),
);
```

## Sandbox-side integration

`sandbox-auth.ts` and `session-sandbox.ts` inject these env vars on every
per-seat sandbox boot (cloud mode):

```
KORTIX_LLM_BASE_URL  = <api-url>/v1/llm
KORTIX_LLM_API_KEY   = <per-member token>
KORTIX_YOLO_API_KEY  = <same token>  (back-compat during opencode transition)
```

The agent (opencode) picks:

```
if (process.env.ANTHROPIC_API_KEY) → call Anthropic directly  (BYOK)
elif (process.env.OPENAI_API_KEY)  → call OpenAI directly     (BYOK)
else                                → call KORTIX_LLM_BASE_URL (Kortix-paid)
```

## Removing the module

Delete the `app.route('/v1/llm', ...)` block in `apps/api/src/index.ts`.
Nothing else in the codebase imports from `llm-gateway/`.
