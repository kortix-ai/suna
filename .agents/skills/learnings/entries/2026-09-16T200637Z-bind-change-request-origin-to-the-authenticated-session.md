---
recorded: 2026-09-16T20:06:37Z
incident_date: 2026-09-16
commit: ed0688c88e
---
# Bind change-request origin to the authenticated session

**When:** opening a change request with a session credential. Derive the origin
from the authenticated `sessionId`; reject a different body `session_id` and a
missing session row. Never let a caller omit the origin that a later merge gate
uses. *Near-miss:* CR open accepted an omitted or foreign `session_id`, so a
session could make its own CR appear unrelated before the self-merge check.
*Enforcer:* `GH-17` opens a CR without `session_id`, rejects a mismatch, and
checks explicit-grant and null-grant self-merge outcomes through HTTP and Git.
