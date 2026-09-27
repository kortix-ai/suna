---
recorded: 2026-09-27T03:11:39Z
incident_date: 2026-09-27
---
# A verification flow must not ask the model the same literal question twice in one conversation

**Rule:** When a flow proves "the answer reflects the CURRENT config/instructions"
across multiple pushes in one OpenCode conversation, give each check a directive
NAME unique to that check (`RELOAD_VERIFY_MARKER_R<round>`), never the same
literal question text more than once. A model sometimes answers a repeated,
identical question from its own prior turn instead of re-reading the current
system prompt — a false "stale config" signature that has nothing to do with
convergence.

**Trigger surface:** Writing or reviewing a `tests/src/flows/*.flow.ts` step (or
any agent eval) that resends one fixed prompt string multiple times in the same
conversation and asserts the answer changed to match a later push.

**Incident:** Preview run 36279090948 (PR #7786) reported CFG-11/CFG-12 failing
with "the answer does not come from the new release" — read as a regression in
`turn-start-convergence.ts`. Reproduced on a real dev Platinum box: pushing 5
config changes and asking the identical `RELOAD_VERIFY_MARKER` sentence each
time answered correctly 4/5 rounds and, on the 5th, echoed the PREVIOUS round's
value — while the daemon's own `[config-release] release applied` /
`[opencode] candidate promoted` log lines showed the swap had completed tens of
seconds before the response. A follow-up question in the SAME conversation,
naming a directive never asked before, answered correctly every time (this is
the existing `RELOAD_VERIFY_MARKER2` / DEF-DEV-2 technique). Repeating the exact
same 5-round race with a round-unique directive name instead of the fixed
sentence: 5/5 correct. No API or daemon code changed; the config-release
pipeline was proven correct throughout. Fixed by making every round's question
text unique (`RACE_MARKER_PROMPT`) in `tests/src/flows/config-releases.flow.ts`.

**Enforcement:** none yet: no lint catches a literal prompt string reused across
`ctx.step`s in one conversation. `tests/src/flows/config-releases.flow.ts`'s
`RACE_MARKER_KEY` comment documents the real-box evidence for the next person
tempted to revert to a fixed sentence.
