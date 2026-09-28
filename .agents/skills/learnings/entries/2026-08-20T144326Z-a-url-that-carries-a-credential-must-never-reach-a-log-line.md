---
recorded: 2026-08-20T14:43:26Z
incident_date: 2026-08-20
commit: 9bf0c3adf5
---
# A URL that carries a credential must never reach a log line

**When:** logging any URL you did not build literally on that line —
WebSocket connect URLs, presigned links, proxy targets, redirect targets.
Browser WebSockets cannot send headers, so auth is smuggled in the query
string (`?token=`), which turns "log the URL you are dialing" into "print the
user's session JWT". Log `url.split('?')[0]`, or the origin + path, never the
whole thing. Reconnect backoffs make it worse: one flapping sandbox reprints
the credential every 1-15s for as long as it flaps.
*Incident:* `pty-terminal.tsx` logged the full PTY WebSocket URL from
`getKortixPtyWebSocketUrl`, which appends the live Supabase access token, on
every connect AND every reconnect. The same file already carried a comment
saying never to echo the token-bearing URL into the visible buffer — the rule
existed, the enforcement did not. Found by audit, not by an incident; fixed in
PR #6663. **No enforcer yet** — a lint rule banning bare `wsUrl`/`url`
identifiers as console arguments is the TODO.
