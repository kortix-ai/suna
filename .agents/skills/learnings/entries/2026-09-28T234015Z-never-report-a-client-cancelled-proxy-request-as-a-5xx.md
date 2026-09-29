---
recorded: 2026-09-28T23:40:15Z
incident_date: 2026-09-28
---
# Never report a client-cancelled proxy request as a 5xx

**Rule:** A reverse proxy answers 499 ("client closed request"), never a 5xx,
when the caller it forwarded the request for has already gone (its `req.signal`
aborted, or the relay fetch rejected with `AbortError`). Only a failure the
origin or the relay itself produced is a gateway error. A 5xx means "the server
failed"; a client that hung up is not a server failure, and counting it as one
turns every bounded client timeout into a page.

**Trigger surface:** Editing any proxy hop that forwards `c.req.raw.signal` to
its upstream (`apps/api/src/llm-gateway/wire.ts` and the sandbox/git proxies),
or reading a route's 5xx rate from the Better Stack log metric.

**Incident:** 2026-09-28, prod. `GET /v1/llm-gateway/v1/models` returned ~10–25
5xx per hour against a 2.58/h baseline, every one the same log line
`[gateway] gateway_proxy_error: The connection was closed.` and every 503 at
~1.98 s. The sandbox boot fetch gives the model catalog a 2 s budget
(`MANAGED_MODELS_TIMEOUT_MS`) and cancels the rest; the proxy relayed that cancel
into a 503 that the infra sweep counted and paged. No customer impact: the
catalog calls that lost the race fall back to the baked catalog. Cost: repeated
false alarms and four failed worker cycles on the issue.

**Enforcement:** `apps/api/src/llm-gateway/wire.test.ts` →
`a client disconnect is 499, never a gateway 5xx`. It answers 503 without the
guard and 499 with it. A real-TCP reproduction of the KRTX-616 fix shows the same
before/after through a socket close.
