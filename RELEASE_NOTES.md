Fix GLM stream failures: pin Z.AI host + trace in-stream upstream errors

Fixes the production "Upstream idle timeout exceeded" turn failures on GLM 5.2.

- Managed `glm-5.2` requests now carry OpenRouter provider routing preferences (`order: [z-ai]`, fallbacks allowed) so they land on Z.AI's first-party endpoint (99.9% uptime, native fp8) instead of being load-balanced across ~20 hosts including low-uptime fp4 requantizations that stall mid-generation until OpenRouter kills the stream.
- The LLM gateway now detects in-stream upstream error frames (a 200 stream carrying `{"error": ...}`) and settles the request as `upstream_stream_error` with a warn log, instead of tracing a dead turn as a success — this failure class is now visible and alertable.
- Pre-content error frames keep flowing into the existing empty-completion retry/failover path (now regression-tested).
