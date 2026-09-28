---
recorded: 2026-09-28T12:25:10Z
incident_date: 2026-09-28
---
# A shared hook calls every platform's handler, and each handler acts only on rows it owns

**Rule:** A platform-agnostic hook (session failure, turn relay, sweep) keeps a list of handlers and calls every one; never a single "last wins" slot. Each platform's loader refuses a row it does not own: a table shared by channels needs an explicit ownership check (`chat_turn_streams.channel_ref` is null for Slack, set for Teams) in every read.

**Trigger surface:** adding a second channel to a hook or table the first channel built alone: `shared/session-failure-notifier.ts`, `chat_turn_streams`, `slack/turn.ts` `loadTurn`, `teams/turn.ts`.

**Incident:** found in the Slack/Teams parity audit on 2026-09-28, live in prod. The session-failure hook held one notifier, Slack's, and Slack's `loadTurn` read any row by session id. In a project with both channels, a Teams session that failed to start was taken for a Slack turn: the Slack post failed and the Teams row was deleted, its card left spinning. Teams had no handler of its own. PR #7965.

**Enforcement:** `unit-session-failure-notifier.test.ts` (every handler called, one failing does not stop the rest), `unit-slack-turn.test.ts` (a Teams row is never Slack's; fails without the guard), `unit-teams-turn.test.ts` (`relayTeamsProvisioningFailure`).
