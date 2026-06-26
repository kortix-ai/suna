# LLM Gateway — reliability hardening

Code-level review of the server-side Kortix LLM gateway (`packages/llm-gateway`
core, shared by the in-process `/v1/llm` pipeline and the standalone pod; control
plane in `apps/api/src/llm-gateway`).

**Verdict: well-architected and production-reasonable.** Layered resilience
(retries w/ backoff+jitter, per-provider circuit breaker, candidate failover, SSE
keep-alive heartbeat), clean routing (Claude→Bedrock, rest→OpenRouter, BYOK→
managed fallback with tier gating), real unit tests on the core pipeline.

## ✅ Fixed (this pass — all with tests)

1. **Reverse-proxy crash guard + target validation** — `wire.ts`
   The `/v1/llm-gateway/*` proxy `fetch` is wrapped in try/catch → clean **502**
   when the standalone pod is unreachable (was an unhandled rejection). The
   target URL is validated (http/https only); a bad `LLM_GATEWAY_PROXY_TARGET`
   disables the proxy instead of forwarding to an arbitrary host.

3. **Streaming settlement no longer silent-fails** — `pipeline/streaming.ts`
   Usage extraction + recordUsage + trace persistence on the stream path are
   wrapped; a failure is logged (`stream settle failed`) instead of becoming an
   unhandled rejection that loses billing/trace. *(test: streaming.test.ts)*

4. **Total-request deadline** — `resilience/retry.ts`
   `withRetry` now enforces a wall-clock `deadlineMs` (default **240s**) across
   all attempts + backoff, capping the old `3 × 120s ≈ 6min` worst case. Slow
   single attempts are unaffected. *(test: retry.test.ts)*

5. **Sliding-window circuit breaker** — `resilience/circuit-breaker.ts`
   Failures now age out of a rolling `windowMs` (default **60s**), so only a
   genuine burst (`failureThreshold` within the window) trips it — a slow drip
   over hours never does. *(test: retry.test.ts)*

6. **Codex refresh grace period** — `credentials/codex.ts` + `codex-core.ts`
   A refresh blip (OpenAI auth briefly unreachable) no longer fails every Codex
   request: if the current access token is still within its validity window it
   keeps serving; the error only surfaces once truly expired. *(test:
   codex.test.ts → `tokenStillValid`)*

7. **Internal token: rotation + timing-safe compare (partial)** —
   `internal-auth.ts` + `internal-routes.ts`
   `GATEWAY_INTERNAL_TOKEN` accepts a comma-separated list (zero-downtime
   rotation) and is compared with `crypto.timingSafeEqual`. *(test:
   internal-auth.test.ts)* — full mTLS/HMAC remains infra work (below).

8. **Missing-pricing no longer silently bills $0** — `pipeline/handler.ts`
   A billable request that prices to $0 (stale catalog → no pricing for the
   resolved model) now logs a warning so the revenue leak is visible.

## ◻️ Remaining (need design / infra, not a code tweak)

2. **Atomic budget check + deduction** — `hooks.ts` / `budgets.ts`
   Check and deduct are still separate, so concurrent requests on one subject can
   overshoot the cap by ~one in-flight request. A correct fix needs a reservation
   (hold) row or a DB-level atomic decrement — a schema + billing-path change
   that should land on its own, reviewed, with its own tests. Overshoot is
   bounded and the gateway is otherwise correct, so this is deferred deliberately.

7b. **Mutual auth API ↔ standalone pod** — beyond the rotation/timing-safe fix
   above, real hardening (mTLS or HMAC request signing) is an infra/deployment
   change, not a code edit. Tracked here.

- **Correlation ID to upstream** — propagate `requestId` as a header for
  cross-provider tracing (minor; needs threading requestId into `callUpstream`).
- **Heartbeat read loop after client disconnect** — currently we keep draining
  upstream to capture full usage even when the client is gone. Intentional
  (billing completeness > the minor wasted read); revisit only if it shows up in
  profiles.
- **Gateway-key `lastUsedAt`** is fire-and-forget (stale admin view only).
- **Idempotency key** — client retries can double-record usage; needs a client
  contract.
- **Per-model / per-request-count rate limit** — only global spend budget today.

## Test gaps still open (need a DB-backed harness)

- Budget enforcement (`checkBudget`) — block vs warn, period rollover.
- Account tier gating + 30s tier-cache TTL.
- BYOK markup / free-tier `billingMode` + managed-fallback resolution.
- Gateway-key expiration in `validateGatewayKey`.
