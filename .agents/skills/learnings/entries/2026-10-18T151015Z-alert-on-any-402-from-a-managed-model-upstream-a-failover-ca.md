---
recorded: 2026-10-18T15:10:15Z
incident_date: 2026-10-18
---
# Alert on any 402 from a managed-model upstream; a failover candidate hides an empty provider balance

**Rule:** Treat a `402` from any Kortix-managed upstream (OpenCode Zen, Morph, OpenRouter) as a page, not a fallback. Keep auto-reload on for every prepaid provider balance. A `failover: true` candidate moves past a `402` silently, so the only signal is `gateway_request_logs.metadata.attemptFailures[].status = 402`.

**Trigger surface:** Adding or reordering a managed-model candidate in `apps/api/src/llm-gateway/resolution/descriptors.ts` (`managedCandidates`: Zen, Morph, OpenRouter), adding a prepaid provider key, or triaging `model_busy` / "is at capacity right now" reports.

**Incident:** 2026-10-15 ~15:00 UTC the prod OpenCode Zen balance ran out. Zen is the first candidate for `glm-5.3-flash` and returned `402 Insufficient account funds` on ~3,000 requests per hour. OpenRouter (decart/coreweave only) took over without an alert. On 2026-10-18 at ~11:00 UTC the OpenRouter GLM pool began to return `429`. `glm-5.3-flash` then failed 64–73% of requests. It is also the fallback for `deepseek-v4.1-flash` and for every `codex/gpt-6.1-sol` request whose ChatGPT pool reached its weekly limit, so ~50% of `codex/gpt-6.1-sol` requests failed with "glm-5.3-flash is at capacity right now." The balance was topped up at 15:06 UTC. The last `402` was at 15:06:07, and `codex/gpt-6.1-sol` went to 0 failures in 477 requests at 15:08. The 402 went unseen for ~3 days.

**Enforcement:** none yet. Build an alert that posts to Slack when any managed-upstream `attemptFailures` entry has status `402` for 5 minutes, plus a balance check for the Zen, Morph and OpenRouter keys.
