---
recorded: 2026-09-14T23:02:42Z
incident_date: 2026-09-14
commit: bd0a6b0b2a
---
# Drop decoded response headers and capture transcripts before manual stop

**When:** forwarding a fetch response or stopping a session. Remove
`content-encoding` and `content-length` after fetch decompresses the upstream body.
Await transcript capture before provider stop; turn-end capture can still be in flight.
*Incident:* PR #7240 live preview: RUN-9 failed with ZstdDecompressionError;
SESS-24 returned an unavailable transcript immediately after manual stop.
*Enforcers:* compressed upstream proxy test, stop ordering tests, RUN-9 and SESS-24.
Live checks also wait for the written artifact, not the first assistant part;
platform names and OpenCode titles are validated independently (GOLD-1, SESS-10).
