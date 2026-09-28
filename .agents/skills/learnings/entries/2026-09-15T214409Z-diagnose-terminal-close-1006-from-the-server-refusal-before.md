---
recorded: 2026-09-15T21:44:09Z
incident_date: 2026-09-15
commit: 52767aef0f
---
# Diagnose terminal close 1006 from the server refusal before calling it a wake

**When:** investigating a browser terminal that fails while CLI attach works.
Match the PTY path and timestamp to `[preview-ws] REFUSED`; a browser error alone
cannot distinguish authentication from readiness. The reported 16:12 EDT session
had 27 `401 unauthorized` refusals from 20:11–20:16 UTC, not readiness 503s.
Its valid HS256 token worked over HTTP but the old WebSocket gate rejected it.
Release 0.13.17 fixed that gate at 20:54 UTC; a real HS256 browser attach now works.
*Enforcers:* `unit-preview-auth-principal.test.ts`, `unit-jwt-alg-fallback.test.ts`;
terminal retries use the HTTP probe in `pty-connection.ts` rather than guessing.
