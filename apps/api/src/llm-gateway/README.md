# llm-gateway

OpenAI-compatible LLM proxy backed by OpenRouter, with an optional **AWS
Bedrock** backend. Self-contained, dependency-injected module — the host wires
it up with three hooks (auth, billing gate, usage sink) and mounts it under any
path.

## Backends

| Model id pattern | Backend |
|---|---|
| `bedrock/*` (e.g. `bedrock/anthropic/claude-opus-4.8`) | AWS Bedrock Converse — *only when `config.bedrock.enabled`* |
| everything else | OpenRouter |

Both backends run behind the same `/chat/completions` route, the same auth +
billing gate, and the same usage-accounting pipeline (`recordUsage`). Usage
events carry `provider: 'bedrock'` vs `provider: 'openrouter'` so spend is
attributable per backend.

### AWS Bedrock

When `config.bedrock.enabled` is true, any request whose `model` starts with
`bedrock/` is served via the Bedrock Runtime **Converse / ConverseStream** API
instead of OpenRouter:

- `services/bedrock-models.ts` — maps the logical id (e.g.
  `bedrock/anthropic/claude-opus-4.8`) to a Bedrock inference-profile id
  (`us.anthropic.claude-opus-4-5-...`) plus per-model fallback pricing.
- `services/bedrock-translate.ts` — **pure** OpenAI↔Converse translation
  (messages, system prompts, tools/tool-calls, images, reasoning/extended
  thinking, streaming → OpenAI SSE chunks). No SDK imports, fully unit-tested.
- `services/bedrock-client.ts` — thin `@aws-sdk/client-bedrock-runtime` wrapper
  (lazy, memoized client; swappable senders for tests).
- `services/bedrock-handler.ts` — orchestrates a completion, mirroring the
  OpenRouter handler's streaming-disconnect handling so usage is still captured
  if the client drops mid-stream.

Credentials use the AWS default chain (env vars, EKS IRSA / instance role) when
`accessKeyId`/`secretAccessKey` are omitted — the production path on our EKS
nodes. The region defaults to `us-west-2`.

Config (env, read in `apps/api/src/config.ts`, wired in `apps/api/src/index.ts`):

```
BEDROCK_ENABLED=true
BEDROCK_REGION=us-west-2
AWS_ACCESS_KEY_ID=...        # optional — default chain used when unset
AWS_SECRET_ACCESS_KEY=...    # optional
AWS_SESSION_TOKEN=...        # optional
```

The `bedrock/*` model ids are also declared in the sandbox `kortix` OpenCode
provider (`apps/kortix-sandbox-agent-server/src/opencode.ts`) so they show up in
the model selector.

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
