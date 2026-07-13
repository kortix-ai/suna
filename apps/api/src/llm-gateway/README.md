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
| `resolution/` | `resolveCandidates` — turns a requested model into ordered upstream descriptors (BYOK → managed fallback, Codex, managed Bedrock/OpenRouter). |
| `budgets.ts` | Per-project / per-member spend caps (`checkBudget`). |
| `models/runtime-catalog.ts` | Fetches provider/model metadata from `LLM_GATEWAY_CATALOG_URL` (models.dev by default), refreshes every 24 hours, and atomically retains the last known snapshot on failure. |
| `models/` | Builds the project/tier-specific catalog served to clients and resolves provider transports from the runtime catalog. |
| `gateway-keys.ts` | Gateway API key (`kgw_…`) lifecycle + validation. |
| `credentials/` | Codex (ChatGPT subscription) credential resolution. |
| `sandbox-credentials.ts` | Which provider env vars are withheld from opencode so the gateway is the only LLM path. |

## Request path

```
client (opencode)
  → POST /v1/llm/chat/completions  (in-API)   or  → standalone gateway pod
       │                                                │  /internal/gateway/* RPC
       └──────────── @kortix/llm-gateway pipeline ──────┘
                       authenticate → billing → budget → resolve-route
                       → resolve upstream descriptors
                       → failover over candidates (retry + circuit breaker)
                       → stream relay (SSE, 10s heartbeat) / json
                       → recordUsage + recordTrace
```

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

## Live e2e

`__tests__/gateway.live.test.ts` exercises the unified pipeline against real
OpenRouter. It is skipped unless `RUN_LIVE_LLM_TESTS=1` and `OPENROUTER_API_KEY`
are set:

```
RUN_LIVE_LLM_TESTS=1 bun test src/llm-gateway/__tests__/gateway.live.test.ts
# or, with .env loaded:  bash scripts/test.sh live
```
