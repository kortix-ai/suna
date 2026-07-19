# LLM Gateway — routing/fallback/cost/latency/evals audit + proposal

> Goal §1: *LLM Gateway to the max: optimal routing, fallbacks, cost/latency-aware.
> Evals/benchmarks become part of the Kortix core system.*
>
> Status: SCOPING (Mirko AGI cycle 35, 2026-07-19). This doc audits the current
> gateway against the goal and proposes the attack sequence.

## What's already built (solid foundation)

The `@kortix/llm-gateway` package (`packages/llm-gateway/src/`) is a mature,
well-structured gateway:

### Resilience — production-grade
- **Circuit breaker** (`resilience/circuit-breaker.ts`): rolling-window failure
  counting (5 failures in 60s → open, 30s cooldown → half-open). Prevents
  cascading failures against a bad upstream.
- **Retry** (`resilience/retry.ts`): exponential backoff with jitter, per-attempt
  timeout, total wall-clock deadline (`deadlineMs` caps the
  `maxAttempts × timeoutMs` blow-up). `isRetryable` classifies which errors
  warrant a retry.
- **Failover** (`pipeline/failover.ts`): multi-model fallback with declarative
  policies. `LIMIT_STATUSES` (402/403/429) trigger fallback (BYOK out of quota →
  managed). `fallbackOn: 'any-error' | 'transient'` per-policy control.

### Routing — declarative policy engine
- **Policy engine** (`routing/policy-engine.ts`): compiles host-provided
  declarative `ModelFallbackPolicy[]` into an exact-match router. Per-model
  fallback models + condition. No provider/model names hardcoded in the gateway
  package (clean separation).
- **Project-scoped routing** (`apps/api/src/llm-gateway/routing/project-policy.ts`,
  `resolve-route.ts`): per-project model pins + fallback rules. Account-level
  defaults + project overrides.

### Transports — multi-provider
- AI-SDK transport (`transports/ai-sdk/`) — the unified engine (OpenAI,
  Anthropic, Bedrock, openai-compatible). Recently rebuilt (v0.10.11 scope).
- Per-call forensics (`/v1/generation?id=<requestId>`) — gateway request logs
  with prompt/completion tokens, cost, latency, attempts, status.

## The gaps (what goal §1 asks for that doesn't exist)

### Gap 1: No cost-awareness in routing (HIGH priority)

**Current:** routing is policy-driven (model → fallback models) but never
considers cost. A request for `gpt-5.5` falls back to `glm-5.2` per policy, but
the gateway doesn't know which is cheaper, doesn't track spend per route, and
doesn't offer a "cheapest model that can serve this request" mode.

**The catalog** (`catalog/`) carries compatibility metadata (which models work
with which transport) but **no pricing**. The `usage/` package tracks cost
post-hoc (for billing/forensics) but doesn't feed it back into routing.

**Proposed:**
1. Extend the model catalog to carry pricing metadata (input/output/cached
   token cost per model). Source: models.dev (already used for capabilities) or
   a static pricing table.
2. Add a `cost-aware` routing mode: when multiple models can serve a request
   (same capability tier), pick the cheapest. Opt-in per project/policy.
3. Surface cost-per-route in the dashboard (the forensics data is already
   collected — just needs aggregation).

### Gap 2: No latency-awareness in routing (HIGH priority)

**Current:** the circuit breaker tracks failure counts but not latency. A
slow-but-not-failing upstream (e.g., 30s responses) never trips the breaker
and gets no routing penalty. The gateway doesn't track P95 latency per
provider/model, doesn't route around slow upstreams, and doesn't expose latency
in the routing decision.

**Proposed:**
1. Track rolling P95 latency per upstream (provider+model). Feed it into the
   circuit breaker: sustained high latency (P95 > threshold) should trip a
   "degraded" state that prefers fallbacks even without hard failures.
2. Add a `latency-aware` routing mode: when multiple models can serve, prefer
   the one with the lowest recent P95. Opt-in per project/policy.
3. The forensics data (`gateway_request_logs.latency_ms`) already exists —
   aggregate it into a rolling per-route latency cache.

### Gap 3: No evals/benchmarks in core (MEDIUM priority)

**Current:** zero eval or benchmark files in the gateway package. No way to
answer "does model X produce quality output for task Y?" or "is the gateway's
routing decision correct for this input?" Quality is entirely human-judged.

**Proposed:**
1. Add an eval framework (`packages/llm-gateway/src/evals/`): define test cases
   (input → expected-behavior), run them against configured models, score
   (exact-match, LLM-judge, or human-reviewed). Start with routing-correctness
   evals (does the policy engine route to the right fallback?).
2. Add a benchmark suite: latency P50/P95/P99 per provider/model (similar to
   the session-boot benchmark harness, #5038 — reuse the pattern).
3. Make evals part of CI for routing-policy changes (a policy refactor that
   breaks routing correctness should fail CI).

### Gap 4: Fallback policy completeness (LOWER priority)

**Current:** `fallbackOn: 'any-error' | 'transient'` — two conditions. No
fallback on specific error codes, no fallback on content-filter flags, no
fallback on quality signals (e.g., empty response, truncated output).

**Proposed:** extend `fallbackOn` to support an array of conditions
(`['transient', 'rate-limit', 'empty-response', 'content-filter']`). Low-risk
additive change.

## Attack sequence (proposed)

**Phase 1 — Cost-awareness (Gap 1).** Highest impact: every request saves money
if routing picks the cheaper equivalent model.
1. Add pricing to the model catalog (static table, sourced from models.dev).
2. Add `cost-aware` routing mode.
3. Surface cost-per-route in the dashboard.

**Phase 2 — Latency-awareness (Gap 2).** Second-highest impact: route around
slow upstreams automatically.
1. Aggregate `gateway_request_logs.latency_ms` into a rolling P95 per route.
2. Feed latency into the circuit breaker (degraded state).
3. Add `latency-aware` routing mode.

**Phase 3 — Evals (Gap 3).** Infrastructure for quality guarantees.
1. Routing-correctness evals (policy engine → expected fallback).
2. Latency benchmark suite (reuse #5038's pattern).
3. CI gate for routing-policy changes.

**Phase 4 — Fallback completeness (Gap 4).** Polish.
1. Extend `fallbackOn` to an array of conditions.

## What I need from a human before code

- **Confirm the priority order** (cost → latency → evals → fallback
  completeness) — this doc assumes cost is highest-impact, but if the team
  prioritizes quality/evals, that reorders.
- **Confirm the pricing data source** — models.dev (already used for
  capabilities) vs. a manually-maintained table vs. provider APIs.
- **Confirm scope** — is this one epic or four? (cost + latency could ship as
  one "smart routing" PR; evals is a separate workstream.)
- **Point at any existing internal cost/latency analysis** I missed.

## Scope of this doc

Grounded entirely in the current codebase: `packages/llm-gateway/src/routing/`
(policy-engine), `packages/llm-gateway/src/resilience/` (circuit-breaker,
retry), `packages/llm-gateway/src/pipeline/failover.ts`, `packages/llm-gateway/src/catalog/`,
`packages/llm-gateway/src/usage/`, `apps/api/src/llm-gateway/routing/`. Every
file/capability verified to exist; gaps verified by `grep` (zero matches for
cost/latency/evals in routing code).
