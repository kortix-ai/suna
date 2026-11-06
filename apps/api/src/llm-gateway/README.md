# LLM gateway control plane

The API owns authentication, billing, model resolution, usage persistence, and
metadata traces. It does not run provider inference.

`apps/llm-gateway` is the only inference process. The API exposes control-plane
RPC routes under `/internal/gateway`. API routes under `/v1/llm` stream requests
and responses to the standalone service without reading their bodies.

## Request path

```text
pi (inside kortixd)
  -> API streaming bridge or gateway load balancer
  -> standalone gateway
  -> authenticate and reserve billing
  -> resolve one model and one upstream
  -> dispatch one provider request
  -> relay provider bytes
  -> settle usage and metadata trace
```

The gateway does not retry, fail over, probe completions, capture bodies, or
retain response streams. The client (pi inside kortixd) owns request retries. The provider owns its
internal availability policy.

OpenAI-compatible providers use one direct `fetch` to `/chat/completions`.
OpenAI Responses, Anthropic, and Bedrock use protocol-specific translation.

## Memory contract

The standalone process reads its cgroup memory limit at boot. Request admission
can use 50% of it. The other 50% is the Bun heap floor, response streams, and
allocator slack.

The admission counter charges `DEFAULT_BODY_AMPLIFICATION` (6) bytes for each
request wire byte, overridable with `GATEWAY_BODY_AMPLIFICATION`. That
factor is measured, not estimated: `packages/llm-gateway/src/pipeline/memory-envelope.test.ts`
drives a 27 MiB, 40-screenshot request through the real handler and records the
peak resident delta at the provider fetch. Measured on 2026-08-24: 2.25x
(openai-compat), 2.9x (anthropic via ai-sdk), 0.61x steady state once the
stream relay is handed back. Those are single-request figures; the constant is
6 because under CONCURRENCY the transient copies of different requests overlap
and GC lags — at 3, sixty concurrent 27 MiB uploads OOM-killed a 2 GiB
container while admission behaved exactly as designed. A declared
`Content-Length` is reserved before the first body read. A chunked body grows its reservation before each chunk is
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

Refusing a request also CANCELS its body. Refusal alone does not stop the
client from uploading, and an unread body is still buffered on the way in —
that is the other half of the same OOM.

A client that disconnects mid-upload releases its reservation. Bun does not
settle a pending body read on abort, so without an abort listener the read
awaited forever holding the lease; capacity then shrank permanently and the
process eventually refused everything while completely idle.

Inline images are also bounded per request, by count and by bytes.
`GATEWAY_MAX_INLINE_IMAGES` (default 20; Bedrock itself accepts 600, probed 2026-11-06) caps
image parts per request; over the cap 13 images survive
(`GATEWAY_IMAGE_KEEP_ON_OVERFLOW`, default 12, plus the newest).
`GATEWAY_MAX_INLINE_IMAGE_BYTES` (default 22 MiB of base64) caps their bytes;
over the cap the newest images within `GATEWAY_IMAGE_KEEP_BYTES_ON_OVERFLOW`
(default 16 MiB) survive. Bedrock refuses a request body over ~32 MB with the
context-overflow text "Input is too long for requested model." at any token
count, so a count cap alone does not protect a screenshot-heavy session. Each
older image becomes the same one-line text notice. The cut moves only when a
cap is crossed again, so the conversation prefix stays byte-identical between
cuts and provider prompt caches stay warm. `0` disables either cap.

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
