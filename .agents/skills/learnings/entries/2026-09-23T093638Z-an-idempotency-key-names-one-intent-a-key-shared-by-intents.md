---
recorded: 2026-09-23T09:36:38Z
incident_date: 2026-09-23
commit: da3b717bf0
---
# An idempotency key names ONE intent; a key shared by intents replays the first one forever

**Rule:** A `createSession` idempotency key identifies one inbound message
(activity id, Slack message ts, email message id), never a conversation or
thread. `session_lifecycle_commands.idempotency_key` is a unique index with no
retention, and `resultFromExistingCommand` answers every later create with the
first command's outcome — including `dead_lettered` and a deleted session's
409. Serialize racing messages with a TTL claim, not with the lifecycle key.
**Near-miss:** Teams, Slack and email keyed creates on the thread since launch;
a Teams chat is one conversation for life, so one failed first start made every
later message in that chat fail the same way, and the agent-picker recovery
could never work. Found in review, PR #7545. **Enforcers:**
`unit-teams-session.test.ts`, `unit-slack-session-selection.test.ts`,
`unit-email-channel.test.ts` (key per message).
