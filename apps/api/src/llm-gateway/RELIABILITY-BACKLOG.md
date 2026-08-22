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
   *(test: call-upstream.test.ts)* — PR #4815.

10. **`GATEWAY_INTERNAL_TOKEN` weak-secret boot warning** — `internal-auth.ts`
    + `internal-routes.ts`. `weakInternalTokenWarnings()` logs a loud
    `[gateway-internal-auth]` warning at boot when the configured token (or any
    entry in the rotation CSV) is under 24 chars or matches a known-weak/default
    value (`test`, `changeme`, etc.). This does not block startup — only a real
    mTLS/HMAC upgrade should ever refuse traffic — it just makes a
    trivial/default static bearer secret impossible to leave unnoticed in a
    prod config. *(test: internal-auth.test.ts)* — cheap hardening only; see 7b
    for the real gap this doesn't close. PR #4815.

11. **Gateway-key validation test coverage** — `gateway-keys.ts`.
    `validateGatewayKey` (the sole auth gate for every `kgw_...` request through
    the standalone/out-of-process `/internal/gateway` RPC path) had zero tests.
    Added a real-DB suite covering: active/no-expiry accepts, future-expiry
    accepts, revoked rejects, past-expiry rejects, the exact expiry-boundary
    instant, `createdBy` null → `userId` falls back to `accountId`, an unknown
    secret, and the fire-and-forget `lastUsedAt` stamp. *(test:
    gateway-keys.test.ts)* — PR #4815.

12. **Tier gating + BYOK free-tier test coverage, and the account-tier cache
    unified to one** — `resolution/resolve-candidates.ts` +
    `billing/services/entitlements.ts`. `resolveCandidates` (BYOK markup/
    free-tier billing-mode branch, managed-model tier gating, managed-fallback
    queuing, codex routing) had zero tests (PR #4815,
    `resolution/resolve-candidates.test.ts`); that PR also gave the (then still
    duplicated) 30s tier cache an injectable `now` so the TTL boundary is
    unit-testable without a real wall-clock sleep. This pass finishes the fix:
    `resolve-candidates.ts` kept its own byte-for-byte duplicate of
    `entitlements.ts`'s own 30s tier cache — the BYOK fee-waiver decision and
    the managed-model free-tier gate could disagree for up to 30s after a tier
    change, independently, because each read a different cache with its own
    expiry clock. Unified to the ONE cache in `entitlements.ts`
    (`getCachedAccountTier` now carries the injectable `now` itself;
    `resolve-candidates.ts`'s `resolveCachedAccountTier` is a thin re-export,
    not a second implementation), plus `invalidateCachedAccountTier` for the
    tier-change-during-window test and any future tier-change webhook.
    *(tests: resolution/resolve-candidates.test.ts's TTL-boundary suite +
    unit-account-tier-cache-unified.test.ts's tier-change-during-window case)*

13. **Genuine-OpenAI streaming $0-billing gap + zero-usage safeguard** —
    `transports/openai-compat/index.ts` + `pipeline/handler.ts`
    `buildUpstreamRequest` now force-injects `stream_options:{include_usage:true}`
    for genuine `api.openai.com` streaming requests (belt-and-suspenders on top
    of the handler's existing generic injection). `settle()` also now logs a
    distinct warning whenever a **billable** request settles with literally zero
    extracted usage — not just zero-cost-with-tokens — so a future
    upstream/provider quirk can't silently zero billing again with no signal at
    all. Gated on `!streamError`: a stream that failed mid-flight (upstream
    error frame, client-abort — see #4821's abort/mid-stream-error handling)
    legitimately bills $0 and is a failed turn, not a usage-extraction bug — the
    two must not be conflated. *(tests: openai-compat.test.ts, handler.test.ts)*

14. **Prompt-cache WRITE tokens priced at a real premium** —
    `usage/{extract,pricing}.ts`, `transports/anthropic/response.ts`,
    `router/config/model-pricing.ts`, `resolution/descriptors.ts`
    Anthropic's `cache_creation_input_tokens` were folded into the plain input
    bucket and billed at the base rate. Now surfaced separately end to end and
    priced at Anthropic's published cache-write multiplier (1.25x base input
    for the default 5-minute TTL — this gateway never requests a 1-hour TTL),
    sourced from models.dev's `cost.cache_write` when available. Hits both BYOK
    Anthropic and managed Bedrock (same transport). *(tests: pricing.test.ts,
    anthropic.test.ts)*

15. **`calculateCost` and `checkBudget` unit-tested** — `usage/pricing.test.ts`,
    `llm-gateway/budgets.ts` + `__tests__/unit-gateway-budgets.test.ts`
    Both had zero real unit tests despite computing/gating every dollar. Now
    covered: cache read/write discount+premium, upstreamCostHint precedence,
    markup=0/>1, malformed usage (cachedTokens > promptTokens), block vs warn
    budgets, project vs member scope, mixed budgets, and the new in-flight
    reservation (below).

16. **`checkBudget` now honors `action='warn'`** — `budgets.ts`
    Previously hard-filtered to `action='block'` — a 'warn' budget (a real,
    persisted, API-creatable option) was fetched nowhere and did nothing.
    `checkBudget` now evaluates both actions; a 'warn' budget never blocks but
    is logged (`[gateway] budget warn threshold reached`) via both the
    in-process and standalone-gateway-RPC call sites.

17. **Discarded-attempt usage folded into the eventual bill (partial)** —
    `pipeline/handler.ts`
    An empty-completion retry / failed-over candidate that still carried real
    usage (a malformed-but-billed generation — the exact OpenRouter/z-ai
    pattern this retry loop exists for) is now summed and folded into the
    eventually-*successful* candidate's billed usage, instead of silently
    discarded. **Not** covered: a request where *every* candidate ultimately
    fails (all-candidates-empty / total failure) still doesn't bill any
    discarded-but-real usage from along the way — deliberately left as a
    follow-up judgment call (billing a fully-failed turn needs its own
    product decision), see PR description. *(test: handler.test.ts)*

### Also landed this wave (sibling PRs, all with tests)

- **max_tokens → max_completion_tokens for genuine OpenAI** — #4805 (+ the
  gpt-5.5 fallback-temperature / playground wire-shape follow-up #4809).
- **Transport correctness** — #4814: `tool_choice:'none'` no longer silently
  becomes Anthropic's default `auto` (safety-critical), plus reasoning-model
  param quirks (temperature/top_p), role normalization, and Bedrock
  event-stream error/exception frame surfacing.
- **LiteLLM stateless translation sidecar** — #4817: per-request translation
  routing behind the control plane (the `translationSidecar` option on
  `callUpstream`).
- **Honest, actionable error taxonomy** — #4820: `resolveCandidates` now throws
  a typed `GatewayResolutionError` (distinct `code` + suggestion:
  `provider_not_connected` / `provider_key_private` / `provider_reauth_required`
  / `plan_upgrade_required` / `model_disabled_on_deployment` / `model_not_found`)
  instead of collapsing every no-upstream case into one generic message; this
  PR's tier-gating/BYOK tests (item 12) assert that taxonomy.
- **Streaming reliability** — #4821: client-disconnect abort propagation
  (see the heartbeat item below), mid-stream error surfacing, bounded buffers,
  and stream deadlines.

## ◻️ Remaining (need design / infra, not a code tweak)

2. **Atomic budget check + deduction (partially closed this pass)** —
   `billing-gate.ts` / `budgets.ts` / `hooks.ts`
   The original framing ("overshoot bounded by ~one in-flight request") was
   itself inaccurate — the stale check spans the WHOLE request lifetime (up to
   the 240s retry deadline), so overshoot scales with concurrency × average
   cost over that window, not a fixed ~1.
   - **Credit/wallet path — real fix**: `checkBillingActive` now takes an
     ATOMIC admission hold (`deductCredits` → the row-locked
     `atomic_use_credits` DB function — the same one the real deduction uses)
     instead of a stale read-only balance check. `recordGatewayUsage`
     reconciles the hold to the real cost at settle (top up the remainder or
     refund the unused portion); every pre-dispatch failure path refunds it
     too (`handler.ts`'s `refundBillingHold`). This closes the admission race
     for the wallet floor itself — concurrent admits now genuinely serialize
     against the true DB balance. Honest limitation: the hold is the existing
     tiny $0.01 floor (not a real cost estimate, to avoid changing
     low-balance-account behavior), so it bounds "N concurrent requests can't
     all pass a balance that can't cover N×$0.01", not "an account can never
     end up owing more than it had" for one expensive turn exceeding a thin
     balance — that residual gap is now the SAME best-effort/logged (not
     silently absorbed pre-hold) behavior, just bounded to (cost − $0.01)
     instead of the full cost. *(tests: unit-billing-gate-atomic-hold.test.ts,
     unit-billing-hold-reconciliation.test.ts, handler.test.ts)*
   - **Project/member 'block' budgets — pragmatic bound, not a full fix**:
     `checkBudget` now adds a conservative, self-expiring in-process
     reservation ($0.50 per in-flight admission, 5-minute TTL) to the
     DB-aggregated spend before comparing to the cap — closing the exact "20
     concurrent sessions" scenario from the audit. This is explicitly NOT a
     real reservation ledger (no release-on-settle, no cross-pod
     coordination, resets on process restart) — a real fix (a persisted
     hold/reservation row, reconciled like the credit path above) is still a
     schema + cross-request-plumbing change that should land on its own. What
     changed the bound from "unbounded" to "concurrency × $0.50" is real and
     shipped; going further is deferred deliberately. *(test:
     unit-gateway-budgets.test.ts, "in-flight admission reservation" describe)*

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

- ~~**Heartbeat read loop after client disconnect**~~ — **addressed by #4821.**
  The old behavior kept draining the upstream to capture full usage even after
  the client was gone (accepted as "billing completeness > the minor wasted
  read"). #4821 (streaming reliability) threads the inbound request's
  `AbortSignal` through the dispatch/relay pipeline: on a client disconnect the
  upstream reader is cancelled (a new `ClientAbortError` stops the failover loop
  and `relayStream` cancels the in-flight read), so a departed client no longer
  keeps spending upstream tokens — plus a stream inactivity deadline bounds a
  silently-stalled upstream.
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
- ~~Account tier gating + 30s tier-cache TTL~~ — closed, see item 12 above
  (TTL-boundary suite + the tier-change-during-window case).
- ~~BYOK markup / free-tier `billingMode` + managed-fallback resolution~~ —
  closed, see item 12 above (`resolution/resolve-candidates.test.ts`).
- ~~Budget enforcement (`checkBudget`) — block vs warn~~ — closed, see item 16
  above (`unit-gateway-budgets.test.ts`, mocked-DB harness). **Period rollover**
  (the `date_trunc` boundary itself) still needs a real Postgres integration
  test — spend is a mocked constant in the unit tests, not a live
  time-bucketed query.
