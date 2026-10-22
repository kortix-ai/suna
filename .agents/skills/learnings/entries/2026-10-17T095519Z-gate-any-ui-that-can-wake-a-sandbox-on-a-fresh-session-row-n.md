---
recorded: 2026-10-17T09:55:19Z
incident_date: 2026-10-17
---
# Gate any UI that can wake a sandbox on a fresh session row, never a cached one

**Rule:** Before the web app opens anything that talks to a session's sandbox on its own (a restored Terminal, Browser or preview), decide on a FRESH session row (`queryClient.fetchQuery(..., { staleTime: 0 })` or `getProjectSession`), not on `useProjectSession`'s cached data. The `inventory` tier keeps that row 30 s, so it can say `running` after the session stopped.

**Trigger surface:** any code that opens a sandbox-backed surface without a click: panel restore, auto-open, prefetch of a PTY or a preview.

**Incident:** 2026-10-17, KRTX-2661 (#10118), caught on the local stack before merge. The first version of the side-panel restore read the cached row, reopened a Terminal on a session stopped 10 s earlier, and the Terminal's failed PTY connect (`503 sandbox not ready`) led to a `/start` without `keep_stopped`, which booted the stopped computer in 818 ms. In production that is a paid box woken by navigation alone.

**Enforcement:** none yet: a unit test pins `panelToRestore` to `status === 'running'`, but nothing checks that the status is fresh. The enforcer to build: a lint rule or test that flags `useProjectSession(...).data?.status` used to gate a sandbox open.
