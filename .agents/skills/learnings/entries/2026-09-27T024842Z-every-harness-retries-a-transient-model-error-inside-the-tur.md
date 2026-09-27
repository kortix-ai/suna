---
recorded: 2026-09-27T02:48:42Z
incident_date: 2026-09-26
---
# Every harness retries a transient model error inside the turn; a turn never ends on one

**Rule:** A model step that fails on a transient provider error (stream closed without `finish_reason`, `terminated`, fetch/socket failure, 408/429/5xx, overload, timeout) is retried inside the same turn, on a bounded backoff, in every harness and for root and child sessions alike. While it waits, the wire shows OpenCode's `retry` session status, never `session.error` + idle. Only an error that outlasts the budget, or a non-transient one (quota, billing, other 4xx, context overflow), ends the turn. When you disable a library's own retry ("Kortix owns retry"), ship the Kortix retry in the same change.

**Trigger surface:** Adding or changing a harness (`apps/kortix-sandbox-agent-server/src/harness/*`), its turn loop, its subagent (`task`) path, its wire adapter, or any setting that turns a library retry off (`harness/pi/extensions/host.ts` sets pi's `retry.enabled: false`).

**Incident:** 2026-09-26/27, prod. Sessions on the pi harness stopped with `Stopped — Stream ended without finish_reason` (pi-ai `openai-completions`: the upstream stream of a managed model closed after ~187 s of reasoning with no finish chunk and no usage frame). pi's AgentSession retry classifies that text as retryable, but the harness had turned it off and implemented no Kortix retry; the open-code auto-resume (`turn-auto-resume.ts`) never runs for pi. One cut ended the whole turn, and every trigger and software-factory worker loop stopped until a human typed "continue". Fix: `harness/pi/transient-retry.ts` (5 retries, 2/4/8/16/30 s), wired into root turns and `task` children, wire `retry` status (PR on branch `turn-resume-stream-cut`).

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` drives the real daemon against a fake OpenAI-compatible gateway that closes the stream with no `finish_reason`: "a stream cut without finish_reason is retried and the turn completes" (root; asserts `retry` statuses and no `session.error`), "a subagent whose stream is cut retries and returns its answer", "a transient error that outlasts the retry budget ends the turn as failed with its reason" (1 + 5 requests), "a non-transient model error is not retried", and "abort during a retry backoff ends the turn as aborted without another request". `turn-auto-resume.test.ts` covers the same text on the open-code harness.
