---
recorded: 2026-10-22T20:49:57Z
incident_date: 2026-10-22
---
# Reject NUL characters in session search before binding PostgreSQL text

**Rule:** Reject U+0000 in session search at HTTP query validation. PostgreSQL text parameters cannot contain NUL. Do not strip it: that changes the search and can broaden the results.

**Trigger surface:** Changing the session-list search query validator.

**Incident:** On 2026-10-22, KRTX-3144 recorded three production session-list failures. A NUL search reached PostgreSQL and returned 500 with SQLSTATE 22021.

**Enforcement:** `tests/src/flows/sessions.flow.ts`, SESS-37, expects 400 for NUL-only, leading, embedded and trailing NUL searches, both flat and root lists. Without validation the first case returns 500.
