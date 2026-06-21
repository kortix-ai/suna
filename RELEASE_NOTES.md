LLM Gateway: BYOK, managed Kortix models, and live cost observability

## LLM Gateway → production

Promotes the full LLM gateway to production — a per-project router with native cost & usage observability, served at gateway.kortix.com.

### Highlights
- **Router** — resolve → route → bill across OpenAI-compatible, Anthropic, Bedrock and Codex transports, with fallback chains and a circuit breaker.
- **Managed models** — Kortix Power (Claude Sonnet) and Kortix Basic (Claude Haiku) on AWS Bedrock.
- **Per-project BYOK** — bring your own provider keys, injected per session.
- **Live pricing** — every LLM call priced from the live models.dev feed (24h refresh) with a 20% margin; no hardcoded price tables.
- **Observability** — Overview, Cost (per-session LLM + sandbox compute), Usage (requests / tokens / latency / errors), Logs, Budgets, API keys, and a Playground.
- **Per-session cost** — LLM + sandbox compute attributed per session.
