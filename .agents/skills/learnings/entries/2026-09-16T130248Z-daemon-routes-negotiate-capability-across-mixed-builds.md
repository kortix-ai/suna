---
recorded: 2026-09-16T13:02:48Z
incident_date: 2026-09-07
commit: 8a7945bb61
---
# Daemon routes negotiate capability across mixed builds

**When:** the API calls a sandbox daemon route. Never assume the API and the daemon
share a build. A health response without `capabilities` means an older daemon: use
a route it already serves (`/file/append`), never a stale classification.
*Incident:* `/file/append` reached a stale daemon, fell through to OpenCode's SPA as
`200 text/html`, and five retries dead-lettered the first prompt.
*Enforcers:* `readRuntimeJson` non-JSON guard and `file.import` negotiation
(`runtime-prompt-file.test.ts`); daemon `/kortix/*` and `/file/*` JSON 404 (`files-routes.test.ts`).
