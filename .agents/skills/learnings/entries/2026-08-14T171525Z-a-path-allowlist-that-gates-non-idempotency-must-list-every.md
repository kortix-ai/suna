---
recorded: 2026-08-14T17:15:25Z
incident_date: 2026-08-11
commit: 83ea8690d6
---
# A path allowlist that gates non-idempotency must list EVERY turn-creating endpoint

**When:** touching the sandbox proxy's retry loop, or adding an OpenCode endpoint
that starts an agent turn.
`routes/preview.ts` derived "is this safe to retry?" from
`shouldSyncProjectEnvBeforeProxy`, a predicate named after env sync whose regex
listed only `/session/:id/{message,prompt_async}`. `POST /session/:id/command` —
what every `/` slash-command posts to — matched neither that nor
`isLongTurnCompletionRequest`. One omission silently disabled FOUR independent
safeguards at once: no dedupe claim, retry-on-5xx allowed, retry-on-ambiguous-
timeout allowed, and a 15s connect cap applied to an endpoint that blocks for the
whole turn. `MAX_RETRIES = 3` then re-POSTed the non-idempotent body, so one user
submit ran the agent four times and billed four turns.
**Rules:** (1) a predicate that answers "may I send this twice?" gets its OWN
name and its own list — never reuse one written for a different question, because
adding an endpoint to one concern silently opts it into or out of the other;
(2) any new turn-creating path must be added to `isNonIdempotentSessionWrite`
(`sandbox-proxy/prompt-dedupe.ts`) AND `isLongTurnCompletionRequest`
(`sandbox-proxy/preview-retry-budget.ts`) in the same commit.
**Enforcement:** both predicates are unit-tested per endpoint in
`prompt-dedupe.test.ts` / `preview-retry-budget.test.ts`. Black-box proof: two
identical `/command` POSTs must yield exactly one new user message.
*Incident:* session `9f6b0d87`, one `/webapp` submit recorded as 4 identical user
messages 11.0s / 11.8s / 13.7s apart (attempt timeout + `RETRY_DELAYS_MS`
[250, 1000, 3000]).
