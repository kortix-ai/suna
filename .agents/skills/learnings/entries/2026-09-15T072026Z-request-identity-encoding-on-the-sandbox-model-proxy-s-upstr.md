---
recorded: 2026-09-15T07:20:26Z
incident_date: 2026-09-15
commit: c22035d0b3
---
# Request identity encoding on the sandbox model proxy's upstream hop

**When:** forwarding model requests through Bun's localhost credential proxy. Set upstream `accept-encoding` to `identity`, since Bun fetch decodes the response before the proxy relays it. *Near-miss:* v0.13.15 preview `GOLD-1` failed its agent turn with `ZstdDecompressionError` at `127.0.0.1:4319`; the proxy forwarded `gzip, deflate, br, zstd` upstream. *Enforcer:* `llm-proxy.test.ts` checks the upstream header; `GOLD-1` must write the file on preview.
