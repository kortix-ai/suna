---
recorded: 2026-09-30T18:09:07Z
incident_date: 2026-09-30
---
# Answer an upstream rejection that arrives before any output as an HTTP error, and publish a context limit one step below the smallest route window

**Rule:** (1) An LLM gateway relay that receives an error as the first `data:` frame of a stream has served nothing: fail the attempt and answer the client with an HTTP error, never a 200 stream carrying the error. (2) Classify every provider's context-overflow wording as `context_length_exceeded`; probe each route and add its text. (3) A model's published `limit.context` sits below the smallest window any serving route accepts, by at least one step of growth. OpenCode compacts at `context - max_tokens`, and a route that checks prompt + `max_tokens` rejects at `window - max_tokens`. (4) A `session.error` for `ContextOverflowError` is not a turn end: OpenCode compacts and continues the same turn.

**Trigger surface:** `packages/llm-gateway` transports and error classification, adding or re-routing a managed model (`packages/llm-catalog` `MANAGED_MODELS`), the sandbox fallback table, and anything that treats `session.error` as a turn end.

**Incident:** 2026-09-30, prod. A trigger re-prompted one long GLM-5.3-Flash session every few minutes, and every turn ended with `UnknownError: {"message":"This request is longer than the glm-5.3-flash context window.","code":"context_length_exceeded",…}`. The published limit (1,048,576) equalled the route windows, so OpenCode's compaction point (1,032,192) was the rejection point of routes that check prompt + `max_tokens`. OpenRouter's Decart endpoint answered 200 and then an in-band 400; OpenCode reads an in-band error object as `UnknownError`, never as an overflow, so it never compacted. CoreWeave's wording ("combined input and output tokens") and Morph's bare "Invalid request" reached clients as `invalid_request`, which wedged DeepSeek V4.1 Flash, the platform default, the same way.

**Enforcement:** `packages/llm-gateway/src/http/call-upstream.test.ts` ("an error as the first data frame throws its status"), `pipeline/simple-handler.test.ts` ("a context overflow reported in-band before output reaches the client as HTTP 400 context_length_exceeded", and the CoreWeave row of the classification table), `packages/llm-catalog/src/managed.test.ts` ("managed context windows": measured window per model, 32,768-token margin), `apps/kortix-sandbox-agent-server/src/__tests__/opencode-events-dispatch.test.ts` ("a ContextOverflowError is not a turn end").
