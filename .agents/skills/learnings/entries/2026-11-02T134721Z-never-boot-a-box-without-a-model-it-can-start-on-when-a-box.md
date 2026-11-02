---
recorded: 2026-11-02T13:47:21Z
incident_date: 2026-11-02
---
# Never boot a box without a model it can start on; when a box reports a failed start, fail the open at once with the box's error

**Rule:** pi does not start without a model, so every session create must resolve one for the box (`KORTIX_MODEL`): the explicit model, the default chain, else the first prompt's pick. A change that removes a box-side fallback (a baked list, a default) must first prove the API always sends one, on every plan. When `/kortix/health` reports the harness `down` with a `boot_error`, the start is over: the open parks the box at once and names that error. It never waits out the not-ready budget.

**Trigger surface:** Changing how a session's model is resolved (`session-create.ts` model step, `default-model.ts`), what the box falls back to when it has no model (`harness/pi/model.ts`), plan entitlements for models, or the `/start` readiness path (`opencode-mapping.ts`, `session-open-readiness.ts`).

**Incident:** 2026-10-30 → 2026-11-02, prod v0.14.12–v0.14.14. PR #11153 dropped the box's baked model list. A free account gets no default model and an empty gateway picker list, and the web sends the model only on the first prompt. So the box booted with no model and pi refused to start ("pi harness has no model"). 14 sessions in 11 free accounts never started; each spun ~7.5 min with no message, because `/start` ignored the box's `boot_error`. Platinum was healthy. Fixed in PR #11463.

**Enforcement:** `sessions.create-characterization.test.ts` (a free account boots on its first prompt's pick), `default-model.test.ts` (a free account with only a Claude account defaults to it), `opencode-mapping-log-root.test.ts` (a down harness's `boot_error` reaches the open), `stopped-wake-result.test.ts` (the cooldown and terminal answers name it), `integration-sandbox-metadata-race.test.ts` (a not_ready answer drops the stale 502 stamp). None yet: a flow that boots a real box on a free account with no default.
