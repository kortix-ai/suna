---
recorded: 2026-08-25T18:41:46Z
commit: 952e400c54
---
# The runtime's body limit is the one that logs, never the one that is silent

*Incident (2026-08-25, SampleCo):* three empty assistant messages in two
sessions were `413 Request Entity Too Large` on image-heavy turns (381k input
tokens, 118 inline screenshots). Nothing in the gateway log explained them:
Bun's own `maxRequestBodySize` default (128 MiB) equals
`DEFAULT_MAX_REQUEST_BYTES`, so Bun refused the body before `fetch()` ran —
plain-text 413, no `request_too_large` step, and a mid-upload socket close on
the first attempt (`Cannot connect to API: The socket…`).

**Rules.**
1. `Bun.serve` in `apps/llm-gateway/src/main.ts` sets `maxRequestBodySize`
   strictly above the pipeline's per-request cap
   (`bunRequestBodyCeilingBytes`), so an over-limit body is refused by the
   pipeline with its logged, digit-free 413.
2. Any host runtime that enforces a body limit of its own (Bun, Caddy, an
   ALB) must be configured above the application's cap, or the application's
   limit is decoration.
3. Raise a self-host gateway's cap through `GATEWAY_MAX_REQUEST_BYTES`; the
   in-flight memory budget clamps it to what the process can hold.

*Automation:* `apps/llm-gateway/src/request-body-ceiling.test.ts`.
