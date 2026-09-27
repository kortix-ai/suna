---
recorded: 2026-09-27T01:50:22Z
incident_date: 2026-09-27
---
# Never flip what a route returns when a parameter is absent; add an opt-out

**Rule:** Before trimming or filtering what a route returns when a parameter is
ABSENT, list every caller that omits it, including binaries baked into sandbox
images and CLIs that ship separately. They cannot be updated in place, so the
absent-parameter answer is frozen: add an opt-out (`include_x=false`) for the
surface you are optimizing, never an opt-in. Parse boolean query flags as an
enum (`z.coerce.boolean()` reads `"false"` as true).

**Trigger surface:** a payload or latency change to a list route
(`/connectors`, `/catalog`, `/branches`, any route a sandbox or CLI reads).

**Incident:** PR #7796 (latency sweep), caught before merge. `/connectors` and
`/catalog` were changed to omit `inputSchema` unless asked, and `/branches` to
hide session branches. The in-sandbox connector gateway reads schemas from
`/catalog`, so every running sandbox would have lost its connector tool
parameters on deploy; the Files version selector and the change-request picker
would have lost session branches. In the same PR: `normalizeString()` returns
`null`, so an `!== undefined` check refused every plain `GET /change-requests`
(`400 Invalid limit`), and prefetching `/start` (consumer `staleTime: 0`) sent
the write twice.

**Enforcement:** `integration-connector-schema-omission.test.ts` (default keeps
schemas), `branches-filter.test.ts` (default keeps session branches; the cap
keeps the default branch), SDK `connectors.test.ts` (a server that ignores
`slug`), `session-route-prefetch.test.ts` (never a `/start`), browser journey
31 (one `/start` per open), flows CR-1 and CR-10.
