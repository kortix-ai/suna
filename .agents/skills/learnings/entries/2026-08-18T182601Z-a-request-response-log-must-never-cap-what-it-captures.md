---
recorded: 2026-08-18T18:26:01Z
incident_date: 2026-08-18
commit: 8cd6f474f1
---
# A request/response log must never cap what it captures

**When:** persisting or rendering a captured request/response body (gateway
traces, debug logs, any "what was actually sent/received" viewer). Do not add
a byte/char cap that silently swaps in `{truncated, bytes, preview}` or a
"...(truncated)" marker — a capped log lies about what happened and there is
no way for the reader to know how much is missing. If two layers each cap
independently (backend storage, then frontend syntax highlighting), the
combination is even harder to notice.
*Incident:* the gateway's `capture()` (256 KiB) and `relayStream`'s response
preview (256 KiB) both truncated request/response bodies before storage, and
the web Logs viewer then ran the residue through Shiki's highlighter, which
separately clamps at 50,000 chars. A 1.66 MB request showed as a
`{bytes, preview}` stub cut a second time. Fixed in #6523: full capture,
uncapped; `HighlightedCode` takes an `unbounded` flag for viewers whose whole
purpose is showing complete content, keeping the clamp elsewhere as a perf
guard for live-streamed re-highlighting.
*Enforcer:* `packages/llm-gateway` handler/streaming tests assert full-length
capture; `shiki-highlighter.test.ts` pins `unbounded` bypassing the clamp.
