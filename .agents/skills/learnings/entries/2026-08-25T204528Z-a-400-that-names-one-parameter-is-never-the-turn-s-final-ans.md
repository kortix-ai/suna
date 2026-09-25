---
recorded: 2026-08-25T20:45:28Z
commit: f23d422285
---
# A 400 that names one parameter is never the turn's final answer

*Incident (2026-08-25 19:40Z, SampleCo session 58da74d4):* the gateway
forwarded a reasoning field in a shape Bedrock's GPT-5.6 profile rejects
(`400 unknown_parameter: reasoning_effort`); every turn on the model died with
an empty assistant message until the wire shape was verified and corrected
(#6893). The project's configured default was the trigger; the live mitigation
was stripping it from `project_llm_routing_policies.model_generation_config`.

**Rules.**
1. `isUnknownParameterRejection(err, param)` (errors.ts) recognises an
   upstream refusing ONE field. The chat handler re-dispatches a Bedrock
   candidate once without `reasoning_effort` and remembers the model
   (`noteBedrockOpenAiRejectsReasoningEffort`); the adapter never attaches the
   field for a remembered model again. One retry, never the turn.
2. The verified wire (#6893) stays the primary path; this is the backstop for
   the next unverified claim, not a substitute for verifying.

*Automation:* `errors.test.ts`, `simple-handler.test.ts`, `ai-sdk.test.ts`
("never receives it again").
