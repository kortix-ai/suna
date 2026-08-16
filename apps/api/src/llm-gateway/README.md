# llm-gateway (API-side control plane)

This directory is the **control plane** for Kortix's LLM gateway. The actual
request pipeline — multi-transport routing, failover, circuit breakers, usage
extraction, streaming relay — lives in the `@kortix/llm-gateway` package and is
shared by two deployments:

- **In-API** (`wire.ts` → `/v1/llm`): the package pipeline runs **in-process**,
  bound to the in-process hooks in `hooks.ts`. Serves self-host / dev, and is the
  fallback when no standalone gateway URL is configured.
- **Standalone pod** (`apps/llm-gateway`): the same package pipeline runs
  out-of-process and reaches this control plane over HTTP via `internal-routes.ts`
  (the `/internal/gateway/*` RPC). This is what serves cloud production — a
  separate pod so long-lived LLM streams aren't cut by API rollouts and it scales
  independently.

There is **one** pipeline implementation; only the hook binding differs (direct
calls in-process vs HTTP from the standalone pod). This API module is the source
of truth for catalog data, route policies, upstream resolution, auth, billing,
budgets, usage, and traces. The package pipeline treats model/provider ids as
opaque values and executes the finite route returned by the control plane.

## Files

| File | Role |
|---|---|
| `wire.ts` | Mounts `/v1/llm` (in-process pipeline), `/internal/gateway` (RPC), and the `/v1/llm-gateway` reverse proxy. Called once from `apps/api/src/index.ts`. |
| `hooks.ts` | Canonical control plane: `authenticatePrincipal`, `assertGatewayBudget`, `recordGatewayUsage`, `persistGatewayTrace`, and `createInProcessGatewayHooks()`. |
| `internal-routes.ts` | Thin HTTP wrappers over `hooks.ts` for the out-of-process gateway pod. |
| `routing/` | Host-owned model defaults and declarative fallback policies; backs `/internal/gateway/resolve-route`. |
| `resolution/` | `resolveCandidates` — turns a requested model into ordered upstream descriptors (BYOK → managed fallback, Codex, managed Bedrock/AsterLab/OpenRouter). |
| `budgets.ts` | Per-project / per-member spend caps (`checkBudget`). |
| `models/runtime-catalog.ts` | Fetches provider/model metadata from `LLM_GATEWAY_CATALOG_URL` (models.dev by default), refreshes every 24 hours, and atomically retains the last known snapshot on failure. |
| `models/` | Builds the project/tier-specific catalog served to clients and resolves provider transports from the runtime catalog. |
| `gateway-keys.ts` | Gateway API key (`kgw_…`) lifecycle + validation. |
| `credentials/` | Codex (ChatGPT subscription) credential resolution. |
| `sandbox-credentials.ts` | Which provider env vars are withheld from the OpenCode process when the gateway owns routing. |

## Request path

```
OpenCode runtime
  → POST /v1/llm/chat/completions  (in-API)   or  → standalone gateway pod
       │                                                │  /internal/gateway/* RPC
       └──────────── @kortix/llm-gateway pipeline ──────┘
                       authenticate → billing → budget → resolve-route
                       → resolve upstream descriptors
                       → failover over candidates (retry + circuit breaker)
                       → stream relay (SSE, 10s heartbeat) / json
                       → recordUsage + recordTrace
```

OpenCode sends its provider traffic through the supported gateway dialect.
Direct project credentials take precedence where OpenCode supports them. A
generic provider-key check does not prove one model. The OpenCode REST smoke
sends a real prompt through each selected provider and model pair.

The standalone pod does not import `@kortix/llm-catalog`. It obtains both the
served model catalog and each request's route plan from this API over the
internal authenticated RPC.

## Runtime routing configuration

The concrete platform policy is deploy configuration, not gateway-core logic:

- `LLM_GATEWAY_DEFAULT_MODEL` — primary target for `auto`.
- `LLM_GATEWAY_VISION_MODEL` — target when the selected model lacks image input.
- `LLM_GATEWAY_FALLBACK_POLICIES` — JSON array of `{ id, models,
  fallbackModels, fallbackOn }` policies.
- `LLM_GATEWAY_MANAGED_MODELS` — optional JSON replacement for the managed-model
  overlay, including transport, upstream id, pricing ref, and capabilities.
- `LLM_GATEWAY_CATALOG_URL` — live provider/model catalog API.

The generic `createModelFallbackPolicyEngine` validates unique ownership and
returns finite ordered routes. The pipeline de-duplicates them and enforces the
configured limit plus a hard ceiling of eight fallbacks.

## Auth & billing

Clients send `Authorization: Bearer <token>`. `authenticatePrincipal` resolves it
in precedence order: gateway API key → legacy YOLO token → account PAT. Billing is
asserted per account; a thrown error becomes a 402 `subscription_required`. Spend
caps are enforced by `assertGatewayBudget` (402 `budget_exceeded`).

## BYOK

BYOK is resolved in `resolution/resolve-candidates.ts`: when the project stores a
provider key for the requested `provider/model`, it becomes the first candidate
(billed `platform-fee` or `none`), with a managed model queued behind it so a
rate-limit / quota error on the user's key fails over instead of failing the turn.

## Usage accounting

`recordGatewayUsage` writes a `usage_events` row (always, for observability —
attributed to `projectId`/`sessionId`) and, when internal billing is on and the
route is billable, debits the wallet via `deductForLlmUsage`. Full request traces
(timings, candidates tried, captured bodies) go to `gateway_request_logs` via
`persistGatewayTrace`.

## Failure contract

A gateway `502` means Kortix exhausted the configured route before it received a
usable completion. It does not identify one provider by itself. The response
body preserves each rejected candidate in `attempt_failures`, in observation
order:

```json
{
  "message": "req_...: All upstream candidates failed: openai-codex/gpt-5.6-sol [HTTP 400, context_length_exceeded]: ...; aster/glm-5.2 [stream_probe_timeout]: ...",
  "code": "context_length_exceeded",
  "provider": "aster",
  "request_id": "req_...",
  "attempt_failures": [
    {
      "attempt": 1,
      "provider": "openai-codex",
      "route_model": "codex/gpt-5.6-sol",
      "resolved_model": "gpt-5.6-sol",
      "stage": "stream_error",
      "status": 400,
      "code": "context_length_exceeded",
      "message": "Your input exceeds the context window of this model."
    },
    {
      "attempt": 2,
      "provider": "aster",
      "route_model": "glm-5.2",
      "resolved_model": "glm-5.2",
      "stage": "stream_probe",
      "code": "stream_probe_timeout",
      "message": "upstream stream probe timeout exceeded (60000ms with no bytes)"
    }
  ]
}
```

The same array exists under `error.attempt_failures` for OpenAI-compatible
clients. Each message is capped at 500 characters. The composite message is
capped at 2,000 characters. The full chain is also stored in
`gateway_request_logs.metadata.attemptFailures` and Langfuse metadata.

If any exhausted candidate reports `context_length_exceeded`, the top-level
`code`, nested `error.code`, and nested `error.type` keep that canonical value.
The HTTP status can remain `502` because the configured route was exhausted.
The gateway also normalizes message-only overflow responses. For example,
OpenRouter can return numeric `error.code: 400` with `maximum context length`
only in `error.message`. This response becomes `context_length_exceeded` while
the original HTTP status and complete message remain available.
OpenCode 1.17.11 reads nested `error.code` and converts this response into a
`ContextOverflowError`. Its session processor then creates an automatic
compaction turn. A later fallback timeout must not replace this classification.

OpenCode 1.17.11 copies `APIError.data.message` into `session.status.message`
but does not copy `responseBody`. The top-level message therefore contains the
request ID and the complete provider/model/status/code chain. The retry UI
remains actionable when that client discards the structured JSON fields.

OpenTelemetry spans expose `kortix.failure_count`, `kortix.failure_codes`,
`kortix.context_rejected`, `kortix.probe_timeout`, and
`kortix.fallback_recovered`. Use `request_id` to correlate the client error,
gateway trace, provider attempt, and session retry.

The standalone and in-process hosts reject request bodies above 8 MiB with
`413 request_too_large`.

### Streaming timeouts

A new streaming response gets a 30-second first-byte **commit deadline** — one
value for every provider, model, and request size.

Exceeding it does not fail the request. The stream is committed to the relay,
which sends response headers downstream and emits a `: keep-alive` SSE comment
every 10 seconds while the model works. The only thing the deadline decides is
how long the gateway holds the response back so it can still fail over to
another candidate; a slow candidate is not a broken one. Every other
content-free probe outcome — a structured error frame, a transport read
failure, a stream that closes without output — still fails over.

The 30 seconds is bounded from above by the edge, not by taste. The live
`kortix.com` zone reports `proxy_read_timeout = 125` seconds with
`editable: false` (Free plan), so an origin that produces nothing for longer
than that gets a Cloudflare 524 regardless of what the gateway does. The same
125 seconds applies to gaps between bytes after headers are sent, which is why
the relay's 10-second heartbeat is load-bearing rather than cosmetic.

Once committed, a stream may go silent for up to 90 minutes before it is
declared dead. That is a **gap** budget measured from the last byte and reset by
every chunk, so it never truncates a long response: a Claude Fable 5 turn
emitting its full 128,000-token ceiling at 50 tok/s runs 42m40s end to end and
is never at risk from it.

`GATEWAY_STREAM_PROBE_TIMEOUT_MS` overrides the commit deadline with an exact
positive value; `0` keeps the default. `GATEWAY_UPSTREAM_TIMEOUT_MS` (default 90
minutes) bounds time-to-headers when streaming and the whole completion when
not.

> Do not reintroduce a request-size-scaled first-byte budget. The retired
> version was `30_000 + ceil((bytes - 64KiB) / 1MiB) * 15_000` capped at
> `120_000`, which handed every body between 3,211,776 and 4,259,840 bytes a
> budget of exactly 90,000 ms and killed healthy large-context reasoning turns
> with `upstream stream probe timeout exceeded (90000ms with no bytes)`. Scaling
> the budget moves the cliff; it cannot remove it, because the same growth in
> context that raises the budget raises the model's prefill time by more.

## Live e2e

`__tests__/gateway.live.test.ts` exercises the unified pipeline against real
OpenRouter. It is skipped unless `RUN_LIVE_LLM_TESTS=1` and `OPENROUTER_API_KEY`
are set:

```
RUN_LIVE_LLM_TESTS=1 bun test src/llm-gateway/__tests__/gateway.live.test.ts
# or, with .env loaded:  bash scripts/test.sh live
```
