---
recorded: 2026-10-19T15:44:34Z
incident_date: 2026-10-17
---
# Give every managed model a second upstream and alert on upstream failures that fallbacks hide

**Rule:** Never leave a managed model with one upstream. Keep at least two independent upstreams (`MORPH_MANAGED_MODELS`, `OPENCODE_ZEN_MANAGED_MODELS`, the OpenRouter pool). Watch the share of requests that meet an upstream failure, not only the final error rate: a fallback that answers hides the failure.

**Trigger surface:** changing a managed model's snapshot, its OpenRouter `only` pool, `MORPH_MANAGED_MODELS`, `OPENCODE_ZEN_MANAGED_MODELS` or `LLM_GATEWAY_FALLBACK_POLICIES`; a provider balance or key change.

**Incident:** 2026-10-16 22:00 to 2026-10-19 04:00 UTC (54 h). The platform default `deepseek-v4.1-flash` had one upstream: the OpenRouter pool pinned to `coreweave/fp8`, a pool shared with every OpenRouter customer. It answered 60 to 80% of DeepSeek requests with HTTP 429. About 28k requests fell back to GLM. 8,472 requests from 120 accounts got the 429 with no fallback: GLM was plan-gated for them. 1,754 more failed after the fallback, because GLM's first upstream (Zen) returned 402 (empty balance) until 2026-10-18 15:06 UTC. OpenRouter's uptime page showed `coreweave/fp8` at 100% throughout. The gateway's `/health` alert counted only final errors (about 15%, threshold 50%), so nothing fired. The outage ended when v0.14.2 moved DeepSeek to `morph/fp8` (#10177), again a single upstream. Fix: #10277.

**Enforcement:** `apps/llm-gateway/src/traffic.test.ts` (an `upstream capacity` incident on `/health` at 20% of requests over 300 s, fallbacks included) and a Better Stack keyword monitor on `https://gateway.kortix.com/health`. `descriptors.test.ts` pins the order Morph direct → Zen → OpenRouter. No test fails when a model has only one upstream in a deployment's env: none yet, the enforcer to build is a boot-time warning in `managedCandidates` callers.
