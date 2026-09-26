---
recorded: 2026-09-17T00:36:13Z
incident_date: 2026-09-16
commit: 3afa460dcc
---
# A retry policy that names error classes must include the timeout class

**Incident.** Release-gate flow `GW-ACCESS-1` failed against deployed staging with
`expected [400], got 503` on a request the project's model-access policy must
reject. Measured on staging: 2 of 30 identical
`POST https://gateway-staging.kortix.com/v1/llm/chat/completions` calls answered
`503 {"code":"gateway_error","message":"Gateway unavailable"}` at 5.14 s and
5.15 s; the other 28 answered `400 provider_disabled` in 2.0-3.2 s. The 5 s is the
gateway api-client's per-attempt budget. `withRetry` settles an overrun attempt
with a `TimeoutError`, and `isRetryable` accepted only `ApiUnavailableError`, so
`maxAttempts: 3` was dead code for the one failure mode retries exist for. The
un-retried throw escaped `authorize()` in `simple-handler.ts` — the only
un-guarded hook call in the pipeline — and was served by the standalone gateway's
catch-all. `requested_model: ""` in the body proves it threw before the request
body was parsed. Run 35012251397 and run 35036053187 carry the same body.

**Rule.** A retry predicate that names error CLASSES must include the class the
retry wrapper produces on timeout, or it silently excludes slow dependencies.
Decide retryability per CALL, not per client: a read or an admission check that
someone is waiting on may be repeated; a settlement WRITE with nobody waiting
may not, because a timed-out attempt the server committed would be charged twice.
Every hook call in a request pipeline classifies its own failure — one un-guarded
call turns a named dependency failure into the catch-all's opaque 5xx.
Never widen a deployed-target assertion to accept a 5xx without reading the
response BODY from the run's artifact; commit `ed9327c4ff` widened this flow to
`[400, 503]` on the reading that "the managed upstream answers 503", and that
run's `results.json` shows the body was this defect.

**Enforcement.** `apps/llm-gateway/src/clients/api-client.test.ts` pins the retry
on a timed-out admission call, the `maxAttempts` stop, and that a settlement
write is NOT retried on timeout. `packages/llm-gateway/src/pipeline/simple-handler.test.ts`
pins the classified `503 admission_unavailable`. Verified over real HTTP against
the real gateway process with a control plane whose first
`/internal/gateway/authorize` takes 6 s: `main` answered `503 gateway_error` in
5017 ms with one authorize call; the fix answered `400 provider_disabled` in
5104 ms with two.
