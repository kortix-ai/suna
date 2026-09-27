---
recorded: 2026-08-25T21:51:18Z
commit: 9e41bb89b3
---
# Every blocking OpenCode endpoint must be exempted in BOTH proxy timeout layers

Found 2026-08-26. `POST /session/:id/summarize` (the /compact flow) failed
100% of the time with `503 {"error":"upstream unreachable","details":"The
operation was aborted."}`. OpenCode holds the summarize response open until
the whole summary turn completes (30s+ on a large model), but both proxy
layers only exempted `message|command` from their short response timeouts:
the in-sandbox daemon (`apps/kortix-sandbox-agent-server/src/proxy.ts`,
`isBlockingTurnRequest`, 10s generic bound — the layer that actually emitted
the error) and apps/api (`sandbox-proxy/preview-retry-budget.ts`,
`isLongTurnCompletionRequest`, 15s bound). Because summarize was also absent
from `isNonIdempotentSessionWrite` (`prompt-dedupe.ts`), the apps/api retry
loop re-POSTed the non-idempotent summarize on each abort, stacking failed
summary-attempt turns into the transcript. This is the THIRD instance of the
same shape: `/message` (original), `/command` (2026-08-11, 4x duplicate
sends), now `/summarize`.

**Rules.**
1. Any OpenCode endpoint that withholds response headers until a model turn
   finishes must be listed in BOTH predicates (`isBlockingTurnRequest` in the
   daemon, `isLongTurnCompletionRequest` in apps/api) AND in
   `isNonIdempotentSessionWrite` so the retry loop never re-sends it.
2. If the endpoint's request body is byte-identical between two deliberate
   user retries (command: `{command,arguments}`, summarize:
   `{providerID,modelID}`), it must be key-gated in
   `shouldClaimPromptDelivery` — a keyless content-hash claim silently
   swallows the user's own retry as `{"deduplicated":true}`.
3. The daemon fix reaches only NEW sandboxes (the daemon is baked into the
   snapshot); apps/api fixes apply on API restart. Verify on a session
   created AFTER the snapshot rebuild, not on the box that reproduced it.

*Automation:* the cross-layer drift test
(`apps/kortix-sandbox-agent-server/src/__tests__/blocking-turn-timeout.test.ts`,
"the two proxy layers agree on which calls block") drives both predicates
with the same paths and fails on any drift, and now covers `summarize`;
`preview-retry-budget.test.ts` + `prompt-dedupe.test.ts` pin the apps/api
side.

*Incident:* no prod outage — caught on local dev, but the identical code
paths ship to prod, where every /compact would have 503'd the same way.
