---
recorded: 2026-09-22T10:36:05Z
incident_date: 2026-09-22
commit: fbe81fc2c8
---
# Reporting a thing and unblocking on it are different code paths — check the one that unblocks

**Rule:** Before telling an agent to use a BLOCKING tool on a new surface,
find the code that RELEASES the block and confirm that surface satisfies its
gate. A relay that reports the event is not the relay that resumes the caller,
and the two are gated differently. **Trigger surface:** enabling an
opencode/agent tool for a channel, or any "this works on platform A, so
recommend it on platform B".

**Incident:** #7493 changed the Teams turn prompt to recommend opencode's
built-in `question` tool, on the strength of reading `POST /turn-question` —
which persists the question, posts the card, and returns a finish-now sentinel.
That is the REPORTING path, and it is ungated. The path that actually releases
opencode's blocking `question` call is a separate POST to
`/question/:id/reply`, gated on `slackRelayContext()` — `SLACK_THREAD_TS` /
`SLACK_CHANNEL_ID`. A Teams session carries `MS_TEAMS_*`;
`harness/open-code/boot.ts` had zero `MS_TEAMS` references. So a Teams agent
posted the card and then hung until its box parked — strictly worse than the
prose it replaced, because the user sees the question and answers a turn that
never finishes. Caught while verifying a claim in the PR description, after
merge, before anyone hit it. **Enforcers:** `sessionChannel()` (daemon
`relay-context.ts`) accepts either platform, asserted by the daemon's
`question-relay.test.ts` for both harness adapters (a Teams session must count
as a channel; the sentinel names the channel it was posted to), and
`unit-channel-question-guidance.test.ts` asserts the two platforms differ ON
PURPOSE until sandboxes carry the fixed daemon.

**Second rule:** a server-side prompt change reaches every running session on
the next API deploy; the sandbox agent server is IMAGE-BAKED and reaches only
sandboxes built after it. When a feature needs both, ship the prompt LAST.
Shipping it first is what made this live before its daemon half existed.
