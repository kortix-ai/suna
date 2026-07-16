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
   internal-auth.test.ts)* — full mTLS/HMAC remains infra work (see 7b below).

8. **Missing-pricing no longer silently bills $0** — `pipeline/handler.ts`
   A billable request that prices to $0 (stale catalog → no pricing for the
   resolved model) now logs a warning so the revenue leak is visible.

9. **Correlation ID threaded to the upstream call** — `http/call-upstream.ts` +
   `pipeline/failover.ts`. `callUpstream()` now accepts a `requestId` and sends
   it as `x-kortix-request-id` on every outbound provider request (all
   transports — set centrally after `transport.buildRequest()`, not per
   transport, so it can't drift out of sync with them); `runFailover` passes
   its existing `requestId` through. A failed/slow completion can now be
   cross-referenced against a provider's own request logs instead of manual
   timestamp/payload matching. requestId was already in logs/traces
   (`pipeline/trace.ts`) — only the wire hop to the provider was missing.
   *(test: call-upstream.test.ts)* — PR test(llm-gateway): close coverage gaps
   + backlog hygiene (correlation id, key validation).

10. **`GATEWAY_INTERNAL_TOKEN` weak-secret boot warning** — `internal-auth.ts`
    + `internal-routes.ts`. `weakInternalTokenWarnings()` logs a loud
    `[gateway-internal-auth]` warning at boot when the configured token (or any
    entry in the rotation CSV) is under 24 chars or matches a known-weak/default
    value (`test`, `changeme`, etc.). This does not block startup — only a real
    mTLS/HMAC upgrade should ever refuse traffic — it just makes a
    trivial/default static bearer secret impossible to leave unnoticed in a
    prod config. *(test: internal-auth.test.ts)* — cheap hardening only; see 7b
    for the real gap this doesn't close.

11. **Gateway-key validation test coverage** — `gateway-keys.ts`.
    `validateGatewayKey` (the sole auth gate for every `kgw_...` request through
    the standalone/out-of-process `/internal/gateway` RPC path) had zero tests.
    Added a real-DB suite covering: active/no-expiry accepts, future-expiry
    accepts, revoked rejects, past-expiry rejects, the exact expiry-boundary
    instant, `createdBy` null → `userId` falls back to `accountId`, an unknown
    secret, and the fire-and-forget `lastUsedAt` stamp. *(test:
    gateway-keys.test.ts)*

12. **Tier gating + BYOK free-tier `billingMode` test coverage** —
    `resolution/resolve-candidates.ts`. `resolveCandidates` (BYOK markup/
    free-tier billing-mode branch, managed-model tier gating, managed-fallback
    queuing, codex routing) had zero tests. `resolveCachedAccountTier`'s 30s
    TTL cache now takes an injectable `now` (defaults to `Date.now()`, every
    production call site unaffected) so the TTL boundary and the "tier change
    during the cache window" bug shape are both unit-testable without a real
    wall-clock sleep. *(test: resolution/resolve-candidates.test.ts)*

## ◻️ Remaining (need design / infra, not a code tweak)

2. **Atomic budget check + deduction** — `hooks.ts` / `budgets.ts`
   Check and deduct are still separate, so concurrent requests on one subject can
   overshoot the cap by ~one in-flight request. A correct fix needs a reservation
   (hold) row or a DB-level atomic decrement — a schema + billing-path change
   that should land on its own, reviewed, with its own tests. Overshoot is
   bounded and the gateway is otherwise correct, so this is deferred deliberately.
   Status as of this pass: still open — tracked separately from tonight's
   `checkBudget` warn-action fix (item below), which does not change the
   check-then-act race.

7b. **Mutual auth API ↔ standalone pod — threat model & scoped follow-up.**
   Current state after items 7 and 10: `GATEWAY_INTERNAL_TOKEN` is a shared
   static bearer, comma-rotatable, compared timing-safe, with a boot-time
   weak-secret warning. There is still no host/identity binding — anything
   holding the token can call the full `/internal/gateway/*` surface
   (authenticate, authorize, resolve-route, resolve-upstream, budget-check,
   record-usage, persist-trace) from anywhere on the network.
   - **Threat model:** the credential is a single Kubernetes/ECS secret shared
     between exactly two known hosts (the API and the standalone gateway pod).
     The realistic exposure is credential leakage (env dump, log line,
     misconfigured secrets sync — the same class of incident as the prior
     `CLOUDFLARE_GLOBAL_API_KEY` plaintext-rotation incident), not on-path
     interception (both hops are already inside the cluster's private network,
     TLS-terminated at the ingress). A leaked token lets an attacker read/mint
     usage records and drive routing decisions for any principal it can name,
     but cannot itself exfiltrate provider credentials (those stay resolved
     server-side, never returned over this RPC) or bypass the per-request
     account/project auth done upstream of these routes.
   - **Why not tonight:** a real fix is mTLS (both hosts already have a
     private DNS identity + the cluster's own CA — this is provisioning/infra
     work, not app code) or HMAC-signed requests (needs a signing-key
     distribution + clock-skew/replay-window design — a small protocol change
     that deserves its own review and tests, not a same-night addition next to
     five other fixes). Neither is a "cheap" change; both are real scope.
   - **Recommended next step:** HMAC request signing is the lower-lift of the
     two (no infra/cert-issuance dependency) — sign `{method, path, body-hash,
     timestamp}` with a key distributed the same way `GATEWAY_INTERNAL_TOKEN`
     is today, reject requests outside a small clock-skew window. Rough size:
     similar to item 7 (a `internal-auth.ts`-sized module + tests) plus a
     client-side signer in `apps/llm-gateway/src/clients/api-client.ts`.
     Tracked here as the next infra-adjacent pass on this RPC boundary, not
     scheduled.

- **Heartbeat read loop after client disconnect** — currently we keep draining
  upstream to capture full usage even when the client is gone. Intentional
  (billing completeness > the minor wasted read); revisit only if it shows up in
  profiles.
- **Gateway-key `lastUsedAt`** is fire-and-forget (stale admin view only).
- **Idempotency key** *(flagged, not implemented — feature, not a fix)* —
  client retries still double-record and double-bill usage
  (`pipeline/handler.ts` / `hooks.ts` `recordGatewayUsage`, confirmed still
  absent in tonight's audit). Needs an `Idempotency-Key` header contract +
  a keyed cache/table to short-circuit `recordGatewayUsage` on a replay within
  a bounded window, plus a documented client contract (opencode and any other
  caller must actually send the header on retry). Scoped follow-up, not a
  same-night addition.
- **Per-model / per-key rate limit** *(flagged, not implemented — feature, not
  a fix)* — only a global $ spend budget exists; a runaway well-behaved caller
  (e.g. a stuck retry loop on a free/cheap model) has no request-count throttle
  and can collaterally trip the shared per-provider circuit breaker for every
  other tenant. Needs a lightweight per-principal (project/key) token-bucket
  limiter ahead of dispatch, independent of the $ budget. Scoped follow-up, not
  a same-night addition.

## Test gaps

- ~~Gateway-key expiration in `validateGatewayKey`~~ — closed, see item 11
  above.
- ~~Account tier gating + 30s tier-cache TTL~~ / ~~BYOK markup / free-tier
  `billingMode` + managed-fallback resolution~~ — closed, see item 12 above.
- Budget enforcement (`checkBudget`) — block vs warn, period rollover. Status
  as of this pass: **not covered by this PR** — `checkBudget` and its
  `calculateCost`/pricing counterpart are being fixed and tested by a parallel
  billing pass the same night (checkBudget currently only ever queries
  `action='block'`, silently never evaluating `warn`-scoped budgets — a
  correctness bug, not just a test gap). If that lands separately, this line
  should be struck; if it hasn't landed, `budgets.ts`/`pricing.ts` still have
  zero tests and this remains open.
