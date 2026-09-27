---
recorded: 2026-08-25T18:55:17Z
commit: 4593364c50
---
# Window inline images inside the sandbox; the edge is too late

*Incident (2026-08-25, SampleCo):* vision-heavy turns accumulated 118 inline
screenshots (>128 MiB per request). The gateway's image window keeps 12, but
only after the body has crossed the wire; the runtime's body ceiling refused it
first and the turn died with an empty assistant message.

**Rules.**
1. Every gateway session routes OpenCode through the daemon's localhost LLM
   proxy (`main.ts`, not only warm hot-swap forks). The proxy applies the same
   window (`llm-image-window.ts`, default keep 12 of ≤20) to `chat/completions`,
   `messages` and `responses` bodies BEFORE they leave the box, and lifts its
   own body ceiling so a large body can be shrunk rather than refused.
2. Kill switch `KORTIX_LLM_PROXY_DISABLE=1` (direct provider config);
   `KORTIX_LLM_MAX_INLINE_IMAGES=0` disables the window only.
3. A live gateway enable/disable (`/kortix/env`) keeps the proxy's upstream +
   token in step (`applyLlmGatewayMode`).

*Automation:* `llm-image-window.test.ts`, `llm-proxy.test.ts` ("in-sandbox
inline image window").
