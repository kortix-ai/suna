---
recorded: 2026-10-13T19:18:57Z
incident_date: 2026-10-05
---
# Flatten no upstream failure: carry the upstream status and body to the caller and the log

**Rule:** When a proxy route turns a failed upstream call into its own error,
the response and one log line must carry the upstream status and a short body
excerpt, and an idempotent call retries the same transient set the codebase
already retries (429 per `Retry-After` capped at 5 s, 5xx with
`attempt × 400 ms` backoff — `slackApiCall` is the reference). Never answer a
bare `HTTP <n>` with no log line and no body.

**Trigger surface:** Any handler that fetches a third-party host and maps
`!res.ok` to a local error — `downloadSlackFile`
(`apps/api/src/channels/slack/file-proxy.ts`), the upload path beside it, and
every future file/passthrough proxy.

**Incident:** 2026-10-05, prod `GET /v1/projects/:id/channels/slack/file`
answered 16 502s within 3 h (8 back-to-back in one minute) while clean 200s
ran between bursts — Slack's files host degraded transiently. Each failure
produced exactly one log line (`download failed: HTTP <n>`, no upstream body,
no other line sharing the requestId), so three root-cause sessions found
nothing and the fourth could only conclude "not reproducible" (KRTX-1658).

**Enforcement:** `apps/api/src/__tests__/unit-slack-file-proxy.test.ts` →
`downloadSlackFile transient upstream failures`: a 503-then-200 and a short
`Retry-After` 429 succeed on the retry; a persistent 503 answers 502 whose
error names `upstream 503` and the body; a 429 with a long `Retry-After`
answers 429; an upstream 403 answers 403; a thrown fetch retries once and
answers 502 instead of crashing the route.
