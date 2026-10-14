---
recorded: 2026-10-14T19:27:41Z
incident_date: 2026-10-09
---
# Never let an unanswered question block a session: a new message dismisses it

**Rule:** A blocking interaction (the `question` tool) must never hold a session forever. In the pi runtime a new user message, admitted or steered, dismisses every open question (`dismissOpenQuestions` in `harness/pi/runtime.ts`), so the blocked turn ends and the message runs. A trigger-started session (`metadata.source` = `trigger:*`) has nobody to answer at all: `POST /turn-question` releases its question at once with a sentinel (`isUnattendedSessionMetadata`, `apps/api/src/channels/question-release.ts`), the same server-side release channel sessions get. The API prompt inbox holds a new message while a turn is active (`turn_active`), so the server-side release, not the runtime, is what frees an unattended session.

**Trigger surface:** Adding or changing a tool that waits for a human (questions, permission asks) in any harness, or a session that runs without a person watching (keyed cron triggers, Slack threads).

**Incident:** 2026-10-09 to 2026-10-14. A keyed cron session on pi called `question` once. Nobody answered, so every 30-minute fire and every routed Slack reply queued behind the blocked turn for 5 days, and the channel's reports never reached the tracker. OpenCode denies `question` only in Slack sessions; pi had no guard.

**Enforcement:** `apps/api/src/__tests__/unit-channel-question-release.test.ts` ('unattended sessions'); `src/__tests__/pi-harness.test.ts`: 'a new prompt dismisses an open question…' and 'a steered message dismisses an open question…'. The company factory watchdog also flags a trigger session holding an open question (`wedged:<slug>`).
