---
recorded: 2026-08-24T04:24:38Z
commit: 83c3bc6936
---
# A transcript list must never carry attachment bytes

2026-08-24. On a self-host, sessions with hundreds of agent image reads stopped
rendering. Every file part carried its whole file as a `data:` url, so
`GET /session/:id/message?limit=20` weighed 7–19 MB. The SDK's 30 s fetch
deadline killed the read at exactly 30.00 s, the tail retry re-issued it, and
the browser downloaded tens of megabytes for a screen that never painted. The
same read answered inside the sandbox in 276 ms; the bytes leaving the sandbox
were the entire cost.

**The rule.** The message list carries a *reference* to an attachment — type,
mime, filename, id — never its bytes. Bytes are served per part, on demand,
`immutable` with a strong ETag. Strip at the daemon (the source) AND at the
API proxy (for sandboxes on an older daemon image); a reference is not a
`data:` url, so the two passes compose.

**The enforcement.** `kortix-sandbox-agent-server/src/__tests__/attachment-strip.test.ts`
drives the real Hono app end to end: the list carries the reference, the part
endpoint returns the exact bytes, 304 on ETag, 404 on unknown, and the
single-message read is NOT stripped. `apps/api/src/sandbox-proxy/inline-attachments.test.ts`
pins the pure transform, including "unrecognised payload passes through
untouched" — the strip runs on every response on that path and must never be
the reason a read fails.

*Incident:* sampleco `5306fd8d`, five consecutive reads at 29.23–30.08 s,
78 MB transferred, nothing rendered. PR #6829.
