---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# Reconstruct OpenCode identities from SQLite columns

Live OpenCode 1.18 rows keep message and part IDs in SQLite columns and omit
them from the JSON `data` payload. The daemon's transcript reader passed that
JSON through unchanged. Quick Queue then mistook the active user message for a
different turn and disarmed its interrupt. The same projection also omitted IDs
from client transcript pages. Hydrate `id`, `sessionID`, and `messageID` from
their authoritative columns before serving a page or checking a tool boundary.

Enforcement: `opencode-db.test.ts` seeds live-shaped rows without JSON IDs and
checks both message and part identities.
