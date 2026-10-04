---
recorded: 2026-09-28T11:57:57Z
incident_date: 2026-09-28
---
# Address a chat conversation from the server's own records, never from a caller-supplied service URL

**Rule:** Every outbound call that carries a bot credential addresses the conversation from the server's own records: a binding row that proves the project talks there, and the service URL inbound activities stored. Never take a service URL, host or tenant from a request body, and never allow a namespace an outsider can register (`*.azurewebsites.net`, arbitrary `*.trafficmanager.net`) in a host allowlist.

**Trigger surface:** a route or CLI command that sends into Teams (or any channel) on the agent's or user's behalf; `teams-service-url.ts`; `teams/file-proxy.ts`; `teams/post.ts`.

**Incident:** found in a code audit on 2026-09-28, live in prod. `POST /projects/:id/channels/teams/file/upload` took `service_url` from the body, and the service allowlist still accepted `*.azurewebsites.net` (dropped only on the download path on 2026-09-18). Anyone with connector-write on a Teams-enabled project could have the managed bot's Bot Connector token sent to a host of their own, and post into any conversation the bot reaches. Not known to be exploited. PR #7963.

**Enforcement:** `unit-teams-service-url.test.ts` (registrable hosts refused), `unit-teams-file-proxy.test.ts` (stored service URL used, unbound conversation 404, non-Bot-Framework stored URL 409), `unit-teams-post.test.ts` (`resolveTeamsProjectConversation`).
