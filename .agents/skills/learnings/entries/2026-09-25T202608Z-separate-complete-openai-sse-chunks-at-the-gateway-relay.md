---
recorded: 2026-09-25T20:26:08Z
incident_date: 2026-09-25
commit: 8796ee5618
---
# Separate complete OpenAI SSE chunks at the gateway relay

**Rule:** On the direct provider stream, insert an SSE event boundary between
consecutive complete `data:` JSON chunks, and terminate a complete final chunk
at EOF. Preserve valid multiline and CRLF events. **Trigger surface:** gateway
SSE relay changes. **Incident:** a managed model emitted nine reasoning chunks
without event separators; the client rejected their joined JSON while gateway
logs recorded HTTP 200. **Enforcers:** `pipeline/streaming.test.ts` and
`pipeline/simple-handler.test.ts` pin client framing, usage, and public rewriting.
