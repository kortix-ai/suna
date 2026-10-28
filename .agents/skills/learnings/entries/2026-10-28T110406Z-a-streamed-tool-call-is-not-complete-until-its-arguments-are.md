---
recorded: 2026-10-28T11:04:06Z
incident_date: 2026-10-28
---
# A streamed tool call is not complete until its arguments are; take them from the final call when no delta came

**Rule:** A stream translator that opens a tool call from a start event still
forwards the final call's arguments when no non-empty delta came for that id.
"Opened" is not "streamed". Each id's arguments go out once.

**Trigger surface:** `packages/llm-gateway/src/transports/ai-sdk/sse.ts`
(`openAiSseFromFullStream`), `ingress/openai-responses.ts`, any tool-call
stream translator.

**Incident:** 2026-10-28, PR #10990. The ChatGPT Codex backend sends parallel
calls' arguments only in `output_item.done`, never as deltas. The gateway
dropped that final `tool-call`, so every parallel Codex call reached the agent
with arguments `{}`.

**Enforcement:** `ai-sdk.test.ts`: "streams the arguments of parallel calls
whose upstream sent no argument deltas" and "tool-call arguments reach the
client exactly once" (mixed step, empty delta, repeated final call).
