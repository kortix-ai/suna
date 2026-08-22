# LLM gateway control plane

The API owns authentication, billing, model resolution, usage persistence, and
metadata traces. It does not run provider inference.

`apps/llm-gateway` is the only inference process. The API exposes control-plane
RPC routes under `/internal/gateway`. API routes under `/v1/llm` stream requests
and responses to the standalone service without reading their bodies.

## Request path

```text
OpenCode
  -> API streaming bridge or gateway load balancer
  -> standalone gateway
  -> authenticate and reserve billing
  -> resolve one model and one upstream
  -> dispatch one provider request
  -> relay provider bytes
  -> settle usage and metadata trace
```

The gateway does not retry, fail over, probe completions, capture bodies, or
retain response streams. OpenCode owns request retries. The provider owns its
internal availability policy.

OpenAI-compatible providers use one direct `fetch` to `/chat/completions`.
OpenAI Responses, Anthropic, and Bedrock use protocol-specific translation.

## Memory contract

The standalone process reads its cgroup memory limit at boot. It reserves 75%
for Bun, JSON objects, transports, and response streams. Request admission can
use the remaining 25%.

The admission counter charges three bytes for each request wire byte. A declared
`Content-Length` is reserved before the first body read. A chunked body grows its
reservation before each chunk is retained. The reservation remains active until
the response reaches EOF or the client cancels it.

The service returns:

- `413 request_too_large` when one request cannot fit.
- `503 gateway_overloaded` with `Retry-After` when the process is temporarily full.

Both responses leave the process alive. A load balancer can send new work to a
different replica. Autoscaling must use gateway concurrency, admission
utilization, or `503 gateway_overloaded` rate. Container restarts are not a
scaling signal.

`GATEWAY_INFLIGHT_BUDGET_BYTES` is an optional amplified-byte override. Leave it
unset so the gateway derives the value from the container limit.

## Observability

Traces contain identifiers, provider, model, status, latency, tokens, and cost.
They do not contain prompts, images, tool payloads, or provider response bodies.
Use `requestId` to correlate the client, gateway, API, and provider.

## Files

- `wire.ts`: internal RPC mount and streaming bridge.
- `hooks.ts`: control-plane operations.
- `internal-routes.ts`: authenticated RPC wrappers.
- `resolution/`: model-to-provider resolution.
- `routing/`: model selection and generation defaults.
- `gateway-keys.ts`: gateway-key lifecycle.
