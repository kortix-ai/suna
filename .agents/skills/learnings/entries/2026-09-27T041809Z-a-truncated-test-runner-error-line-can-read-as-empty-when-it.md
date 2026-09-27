---
recorded: 2026-09-27T04:18:09Z
incident_date: 2026-09-27
---
# A truncated test-runner error line can read as empty when it is actually a real error message cut off

**Rule:** When a flow's own error message ends with a colon and nothing after
it (e.g. `"the answer does not come from the new release: "`), do not read
that as "the value was empty." Console/log lines are truncated (this suite's
runner cuts flow-failure summaries at ~200 chars); pull the full, untruncated
result — the run's `results.json` artifact, not the console line — before
concluding a response was empty. An OpenCode assistant message with an
`error` block (no `text` part) also joins to an empty string under a
`.flatMap(part => part.text)`-style assertion, which looks identical to a
model that answered nothing.

**Trigger surface:** Diagnosing any `tests/src/flows/*.flow.ts` failure whose
error string is empty or looks truncated, especially one that reads like a
content/staleness bug (a config, a marker, an answer) rather than an
obvious transport error.

**Incident:** Preview run 36279090948 (PR #7786) and #7796's control run
36287293649 both failed `CFG-11`/`CFG-12` with `"the answer does not come
from the new release: "` — read first as a stale-config regression, then as
an interrupted/empty LLM turn. The real cause, found only after pulling
`results.json` and reading the assistant row's `error` block directly, was a
plan-tier gate: the flows' sessions request a managed model
(`kortix/deepseek-v4.1-flash`) but never entitle their account, so every real
turn 400s `"<model>" requires a paid plan.` (`plan_upgrade_required`,
`apps/api/src/llm-gateway/resolution/resolve-candidates.ts`) before it
reaches OpenCode — unrelated to config releases or the turn-start gate. Two
people (one human, one agent) independently mis-theorized "empty answer" as
a convergence defect before checking the untruncated artifact. Fixed by
entitling the account in `tests/src/flows/config-releases.flow.ts` via
`tests/src/fixtures/billing.ts`'s `subscribe()`, the same fixture the `BILL`
flows already use.

**Enforcement:** none yet: no lint flags a flow assertion that string-joins
`.text` fields without also surfacing `info.error` when present. `CFG-11`
and `CFG-12` now entitle their account before asserting on a managed-model
turn, closing this specific instance.
