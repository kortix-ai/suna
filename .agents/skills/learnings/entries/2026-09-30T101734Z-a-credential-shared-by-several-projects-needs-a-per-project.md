---
recorded: 2026-09-30T10:17:34Z
incident_date: 2026-09-29
---
# A credential shared by several projects needs a per-project read rule on top of it; the token alone is not a boundary

**Rule:** When several projects resolve the same platform credential (the
managed Slack bot token of a workspace, the managed Teams app's Graph token of
a tenant), every read made with it must pass a check that the target belongs to
the calling project. Take ownership from rows only the platform paths write
(`chat_channel_bindings`, `chat_threads`, `chat_installs`), never from the
request.

**Trigger surface:** Adding or changing a channel connector action
(`connectors/channels.ts`), a route that calls Slack or Graph with
`channelToken` or `loadSlackTokenForProject`, or any other install that fans
one credential out to several projects.

**Incident:** 2026-09-29, a near-miss found after the Teams/Slack permissions
audit (PR #8302). An agent in one project could read, through `kortix_slack`
and `kortix_teams`, the channels, DMs and threads of every other project in the
same Slack workspace or Teams tenant. No exploitation found. Fixed on branch
`claude/suspicious-agnesi-c6cd16` by `connectors/channel-read-scope.ts`.

**Enforcement:** `connectors/channel-read-scope.test.ts` fails when a Slack or
Teams catalog action has no read scope; `integration-channel-read-scope.test.ts`
proves the ownership SQL on PostgreSQL; `unit-connector-router-deps.test.ts`
fails when db-deps stops wiring `gateChannelRead`.
