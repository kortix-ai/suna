The LLM Gateway, rebuilt on the Vercel AI SDK and live models.dev

The LLM Gateway, rebuilt on the Vercel AI SDK and live models.dev — with per-model controls, OpenAI- and Anthropic-compatible APIs, and a full UX overhaul. Plus new business use-case templates and a round of security/compliance hardening.

## LLM Gateway
- **Rebuilt on the Vercel AI SDK + live models.dev.** The gateway now runs a single AI-SDK transport for every provider (OpenAI, Anthropic, Bedrock, OpenRouter and more), with the model catalog served verbatim from models.dev. The old per-provider transports and the LiteLLM sidecar have been removed.
- **Per-model generation controls.** Set reasoning effort, temperature, top_p, and max output tokens per model — each control only appears when the model actually supports it (driven by the live catalog), and applies to every client (chat, SDK, and direct API).
- **Reasoning-effort selector in the chat composer** for models that expose it (including a thinking-effort control for Claude models).
- **Two drop-in API surfaces:** OpenAI-compatible `/v1/chat/completions` and Anthropic-compatible `/v1/messages`, plus `/v1/models` — all now documented in the API reference.
- **Provider & model manager overhaul:** connect providers (incl. Bedrock via bearer token), browse models with pricing, context windows, and capabilities, verify that a key actually works, and see everything grouped under its real provider.
- **Anthropic extended thinking and prompt caching** are applied correctly, and cost/usage are recorded accurately per request.
- A gen_ai.* OpenTelemetry span is emitted per gateway call for downstream observability.

## Templates
- Many new business use-case templates across finance, sales, customer support, marketing, data, and recruiting — each with its own cover art.

## Fixes & hardening
- Sandbox proxy no longer times out healthy long reasoning/tool turns.
- Blank projects can start sessions immediately (no more "agent not declared").
- Project-scoped API tokens can drive their own project's sessions.
- Per-project agent model pins no longer collide across projects.
- Faster session/gateway paths and clearer errors on upstream failures.
- Security & compliance: GuardDuty runtime monitoring, IAM baseline, root-login and patch/detection alerting, and corrected SSO/SCIM setup guides.
