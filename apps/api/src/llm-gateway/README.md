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

The standalone process reads its cgroup memory limit at boot. Request admission
can use 50% of it. The other 50% is the Bun heap floor, response streams, and
allocator slack.

The admission counter charges three bytes for each request wire byte. That
factor is measured, not estimated: `packages/llm-gateway/src/pipeline/memory-envelope.test.ts`
drives a 27 MiB, 40-screenshot request through the real handler and records the
peak resident delta at the provider fetch. Measured on 2026-08-24: 2.25x
(openai-compat), 2.9x (anthropic via ai-sdk), 0.61x steady state once the
stream relay is handed back. A declared `Content-Length` is reserved before the
first body read. A chunked body grows its reservation before each chunk is
retained. The reservation remains active until the response reaches EOF or the
client cancels it.

Copies of one request body, in order, and when each dies:

1. Byte buffer while the body arrives (`readAdmittedBody`). One preallocated
   buffer for a declared length; freed after the single decode to a string.
2. The string, freed after `JSON.parse`.
3. The parsed object graph. Base64 image data stays a substring of it: the
   ai-sdk transport hands each `data:` image to the SDK as tagged inline
   `{type:'data', data:<base64>}`, which `@ai-sdk/anthropic` and
   `@ai-sdk/amazon-bedrock` serialize through the identity `convertToBase64`.
   No decode and no re-encode happen. The handler nulls its reference to the
   graph the moment dispatch has taken it, before waiting on the provider.
4. The serialized provider payload and its encoded request bytes, owned by
   `fetch` until sent.

Inline images are also bounded per request. `GATEWAY_MAX_INLINE_IMAGES`
(default 20, Bedrock Converse's hard limit) caps `image_url` parts per request;
over the cap the `GATEWAY_IMAGE_KEEP_ON_OVERFLOW` (default 12) most recent
images survive and each older one becomes a one-line text notice. Dropping to
12 rather than 20 keeps the conversation prefix byte-identical for the next 8
turns so provider prompt caches stay warm. `GATEWAY_MAX_INLINE_IMAGES=0`
disables pruning.

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
