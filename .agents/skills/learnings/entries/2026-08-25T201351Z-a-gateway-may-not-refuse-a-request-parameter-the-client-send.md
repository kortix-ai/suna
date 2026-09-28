---
recorded: 2026-08-25T20:13:51Z
commit: b9aea52753
---
# A gateway may not refuse a request parameter the client sends by default

Found 2026-08-25 on dev, one hour after #6887 deployed. The bedrock adapter
answered `400 unsupported_param` for a `reasoning_effort` it could not map
(Nova, Grok, DeepSeek on Bedrock). The first turn of a fresh project — the
auto-seeded `amazon-bedrock/xai.grok-4.6`, no tier picked — failed with that
400. opencode attaches a default reasoning effort to every reasoning-capable
model, so refusing the parameter refused the model, managed Grok included.
Reverted in #6893 to a documented drop.

**Rules.**
1. Before a gateway refuses a request field, capture what opencode sends for a
   turn where the user set nothing. A field present by default is part of the
   model contract, not a user choice.
2. Verify a provider wire shape against the real provider before mapping it.
   The AI SDK's mapping is a hint: `@ai-sdk/amazon-bedrock` 5.0.59 emits
   `reasoning_effort` for OpenAI ids; Bedrock GPT-5.6 rejects it with
   `unknown_parameter` and accepts `reasoning: { effort }` (verified with the
   SampleCo account, us-west-2, every published tier).
3. Prefer "drop and document" over "refuse" for a field with no verified
   mapping; log the drop so the gap is visible.
4. A dev verification with a fake provider key proves routing only. Use a real
   key (a short-lived Bedrock bearer token from `aws-bedrock-token-generator`
   on the provider account's profile) before calling a wire mapping verified.

*Automation:* `packages/llm-gateway/src/transports/ai-sdk/ai-sdk.test.ts`
pins the drop for Nova/Grok and the `reasoning.effort` shape for OpenAI ids.

*Incident:* dev only; every Grok-on-Bedrock turn 400'd between the #6887
deploy (`2635791cf1`) and the #6893 deploy (`77ec6b2307`), about 70 minutes.
Prod was not promoted in that window. No data loss.
