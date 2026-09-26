---
recorded: 2026-08-24T05:00:55Z
commit: 0727e9aa42
---
# A re-framed body must not carry the provider's framing headers

2026-08-24. The gateway forwarded `upstream.headers` unchanged on both response
paths. `fetch` had already gunzipped the provider body and the gateway
re-materialized it (a string, or a relayed stream), but the response still
said `content-encoding: gzip` with the compressed `content-length`. The API
reverse proxy's `fetch` threw `ZlibError` on every non-streaming completion
and answered `502 gateway_proxy_unreachable` while the gateway itself had
logged a 200. Caddy on a self-host box passes the same pair straight to the
client.

**The rule.** When a proxy decodes or re-frames a body, it owns the framing.
Strip `content-encoding`, `content-length`, `transfer-encoding` and the
hop-by-hop set (RFC 7230 §6.1) before forwarding; keep everything else.
`curl` without `--compressed` ignores `content-encoding`, so a curl-only
check passes while every `fetch`-based client fails — test through the real
next hop.

*Incident:* local stack, found during the passthrough e2e for the memory work
above; the same code is live on dev. Enforcement: `simple-handler.test.ts`
"drops wire-framing headers", `passthroughHeaders()` on all three response
paths.
