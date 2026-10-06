---
recorded: 2026-10-06T15:53:29Z
incident_date: 2026-10-06
---
# Count every in-flight request, stream and detached promise, and drain them before exit; a webhook that acks first releases its dedup claim when its work fails

**Rule:** Register every request, streamed body and detached promise with `shared/drain.ts` (`beginWork`, `trackDetached`); shutdown waits for them before `process.exit`. A handler that answers 200 before it works takes its dedup claims inside `runWebhookWork` (`channels/webhook-work.ts`), which releases them when the work fails.

**Trigger surface:** Writing a shutdown path, a webhook that acks first, or any `void (async () => …)()` that holds a claim.

**Incident:** Audit 2026-10-06. `bootstrap.ts` exited a few seconds after SIGTERM although ECS gives 120 s: every rollout cut in-flight requests, SSE streams and detached webhook handlers. A webhook handler that crashed or threw kept its `chat_event_dedup` claim, so the provider's retry was dropped and the message was lost.

**Enforcement:** `shared/drain.test.ts` and `channels/webhook-work.test.ts` cover the contract. None yet: a lint that flags a bare `void (async` in `channels/**` routes.
