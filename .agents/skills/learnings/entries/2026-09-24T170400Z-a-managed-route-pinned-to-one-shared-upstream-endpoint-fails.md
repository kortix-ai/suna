---
recorded: 2026-09-24T17:04:00Z
incident_date: 2026-09-24
commit: 8ab87305e7
---
# A managed route pinned to one shared upstream endpoint fails every time that endpoint's pool is busy

**Incident.** `glm-5.3-flash` answered HTTP 429 on most turns. The route pinned
one OpenRouter endpoint (`only: ['coreweave/nvfp4']`, `allow_fallbacks: false`).
That endpoint serves all non-BYOK OpenRouter traffic from one shared pool
(`limit_source: upstream_provider_shared_pool`). On 2026-09-24 it returned 429
for 11 of 15 requests routed to it. The 429 was recorded on 2026-09-18 and
shipped anyway. The raw upstream body also reached the session: it named the
endpoint provider and linked openrouter.ai.

**Rules.**
1. A managed model has at least two upstreams, each verified with a real
   text + image + tool request. An OpenRouter `only` list with
   `allow_fallbacks: false` does not fail over inside the list: 4 of 6 probes
   returned the first member's 429 while another member was healthy. Use
   `allow_fallbacks: true` with `only`.
2. HTTP 200 does not prove an image was read. Two DeepSeek endpoints answered
   200 with "I don't see an image". Assert on the answer's content.
3. A managed upstream's identity never reaches a client. Rewrite errors, bodies,
   SSE events, headers, and customer-visible records. Keep the real upstream
   in staff-only channels.

**Enforcement.** `packages/llm-catalog/src/managed.test.ts` (pool size ≥ 5,
`allow_fallbacks: true`, `max_price`, the excluded endpoints),
`packages/llm-gateway/src/pipeline/simple-handler.test.ts` (failover and
public-identity suites), `apps/api/src/llm-gateway/__tests__/gateway.live.test.ts`
(real Morph + OpenRouter). PR #7589.
