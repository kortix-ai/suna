---
recorded: 2026-08-24T05:00:55Z
commit: 0727e9aa42
---
# The edge never rewrites an origin error

2026-08-24. The `api-router` Worker replaced every origin 502/503/504 with a
synthetic `503 MAINTENANCE_MODE` "Service maintenance" page. On dev, 5 of 8
non-streaming completions were failing with a gateway content-encoding bug
(origin 502) and every user, log line and OpenCode retry classifier saw
"Kortix is temporarily unavailable" instead. The gateway's own health showed
`errors: 0` and 3.6 h of uptime: nothing was in maintenance and nothing had
crashed.

**The rule.** A proxy passes the origin's status, body and headers through
unchanged. The only synthetic error it may produce is for an origin it could
not reach at all, and that response names itself (`502 origin_unreachable`,
`X-Origin-Status: fetch-error`, `Retry-After`). A maintenance page comes only
from an explicit admin state. When a proxy catches an exception, the response
carries the exception class and message (`gateway_proxy_error` with `cause`
and `detail`), not a generic "unreachable".

*Incident:* dev, found while verifying the gateway passthrough work above.
Enforcement: `worker.test.mjs` origin-passthrough tests; `wire.ts` proxy
error envelope.
