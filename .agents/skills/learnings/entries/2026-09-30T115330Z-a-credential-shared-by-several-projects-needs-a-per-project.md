---
recorded: 2026-09-30T11:53:30Z
incident_date: 2026-09-29
supersedes: 2026-09-30T101734Z-a-credential-shared-by-several-projects-needs-a-per-project.md
---
# A credential shared by several projects needs a per-project rule for reads and writes; a thread bind lands only in a workspace the install proved

**Rule:** When several projects resolve the same platform credential (the
managed Slack bot token, the managed Teams app's Graph token), every read AND
every write made with it must pass a check against the calling project:
reads reach only its own conversations, writes never act inside another
project's channel or thread. Take ownership and the workspace from rows only
the platform paths write (`chat_channel_bindings`, `chat_threads`,
`chat_installs`), never from the request body or a writable secret such as
`SLACK_TEAM_ID`. What changed: the superseded entry covered reads only.

**Trigger surface:** Adding or changing a channel connector action
(`connectors/channels.ts`), a route that calls Slack or Graph with the channel
token, `bindSlackThreadToSession`, or any install that fans one credential out
to several projects.

**Incident:** 2026-09-29 near-miss after the Teams/Slack permissions audit
(PR #8302). Reads fixed in PR #8345. Writes: one project's agent could post into
another project's Slack channel and collect the replies, reply into its threads,
edit or delete its bot's messages, and bind a thread in a workspace named in the
request body. No exploitation found.

**Enforcement:** `connectors/channel-write-scope.test.ts` fails when a Slack
catalog write has no rule; `integration-channel-write-scope.test.ts` proves the
SQL, the routes, and that an overwritten `SLACK_TEAM_ID` does not move a bind;
`unit-connector-router-deps.test.ts` fails when db-deps stops wiring
`gateChannelWrite`. The read enforcers of the superseded entry still hold.
