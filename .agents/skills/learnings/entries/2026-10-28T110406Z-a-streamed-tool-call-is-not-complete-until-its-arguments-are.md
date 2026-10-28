---
recorded: 2026-10-28T11:04:06Z
incident_date: 2026-10-28
---
# A streamed tool call is not complete until its arguments are; take them from the final call when no delta came

**Rule:** When a stream translator opens a tool call from a start event, it must
still forward the arguments of the terminal call event when no argument delta
arrived for that call id. "Opened" is not "streamed". Never assume an upstream
streams arguments as deltas.

**Trigger surface:** `packages/llm-gateway/src/transports/ai-sdk/sse.ts`
(`openAiSseFromFullStream`), `ingress/openai-responses.ts`, or any other
translator from one tool-call stream format to another.

**Incident:** 2026-10-28, image-gen branch. The ChatGPT Codex backend sends a
PARALLEL function call's arguments only in `function_call_arguments.done` and
`output_item.done`, never as `function_call_arguments.delta` (a single call
streams deltas). ai-sdk emitted `tool-input-start` then `tool-call{input}`. The
gateway dropped that `tool-call` because the id had "already streamed", so every
parallel call of a Codex model reached the agent with arguments `{}` and failed
tool validation.

**Enforcement:** `packages/llm-gateway/src/transports/ai-sdk/ai-sdk.test.ts`
("streams the arguments of parallel calls whose upstream sent no argument
deltas": the captured Codex event shape through the real ai-sdk Responses model)
and the existing "streams tool calls as incremental OpenAI tool_calls deltas"
test (no duplicate arguments when deltas did stream).
