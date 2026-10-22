---
recorded: 2026-09-30T15:20:48Z
incident_date: 2026-09-30
---
# Wait for a session's boot turn to end before a flow puts its box behind and prompts

**Rule:** A flow that pushes to the base branch and then prompts, to prove the
prompt runs on the new release, must first wait until the session's own boot
prompt has ended (`GET …/turn` shows no turn and the transcript holds a
completed assistant row). A turn in flight blocks the turn-start convergence by
design, so a prompt that lands inside the boot turn is answered on the old
release: a false "stale config" failure.

**Trigger surface:** Writing or reviewing a `tests/src/flows/*.flow.ts` step that
creates a session with a boot prompt and then pushes and prompts; reading a
CFG-11/CFG-12 failure "the answer does not come from the new release".

**Incident:** PR #8451, a real OpenCode box on the local stack: the boot turn
ran 14:48:19–14:48:25, the flow pushed and prompted at 14:48:22, the API logged
`turn-start config convergence … outcome: "busy"`, and the box fetched the new
release only after the prompt had finished. Two earlier runs passed by timing.

**Enforcement:** `boxSession` in `tests/src/flows/config-releases.flow.ts` waits
for the boot turn to end, as `bootSession` in `tests/src/fixtures/session-run.ts`
does. No lint yet catches a new flow that skips the wait.
