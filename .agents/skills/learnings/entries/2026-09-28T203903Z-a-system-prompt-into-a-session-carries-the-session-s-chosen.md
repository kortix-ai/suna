---
recorded: 2026-09-28T20:39:03Z
incident_date: 2026-09-28
---
# A system prompt into a session carries the session's chosen agent and model

**Rule:** A prompt the platform sends into a session (approval resume,
connector connected, secret submitted, auto-recovery, a trigger) runs on the
agent and model the session last chose. Deliver it through
`deliverQueuedContinue`, which fills a missing model from the newest turn that
named one. Never post a model-less prompt to OpenCode.

**Trigger surface:** Adding a producer of `continue_session` commands, or a
new path that calls `postPrompt` / `continueSession` without `overrides`.

**Incident:** 2026-09-28, prod. A human denied a gated `gmail.send_draft`; the
approval-resume prompt carried no model or agent. OpenCode ran the default
agent's raw `model:` pin (`codex/gpt-6-sol`, not a provider in gateway mode)
and the session stopped with `Model not found: codex/gpt-6-sol.`, while every
user turn ran on the composer's model. Every model-less system continuation
had the same exposure. Fixed in #8019.

**Enforcement:** `apps/api/src/__tests__/integration-continue-inherits-turn-model.test.ts`
(db-suites) fails if a continuation without a model stops inheriting the
session's agent/model/variant.
