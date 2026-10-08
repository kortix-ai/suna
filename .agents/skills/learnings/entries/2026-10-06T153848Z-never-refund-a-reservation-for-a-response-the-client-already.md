---
recorded: 2026-10-06T15:38:48Z
incident_date: 2026-10-06
---
# Never refund a reservation for a response the client already received: a missing usage frame settles at the held amount

**Rule:** Settle a delivered response at the amount the reservation already holds when the upstream reports no usage. Never refund it. Force `stream_options.include_usage` on managed chat streams and read `response.usage` from Responses `response.completed` frames, so a usage frame arrives. A refund is only correct when the client received nothing.

**Trigger surface:** Editing `settleStreamUsage` or the proxy handlers in `apps/api/src/router/`, or adding any metered passthrough (a new provider, a new streaming protocol).

**Incident:** 2026-10-06 audit. `router/services/llm.ts` refunded the whole reservation when no usage frame arrived. OpenAI chat streams send none unless asked, and Responses streams carry usage under `response.completed`, so any managed OpenAI stream billed $0. The caller controls the stream option, so inference was free on the Kortix key.

**Enforcement:** `apps/api/src/router/services/llm-stream-usage.test.ts`: chat, Responses and Anthropic SSE fixtures, plus a stream with no usage frame (held amount kept, no refund) and a stream that breaks after bytes arrive.
