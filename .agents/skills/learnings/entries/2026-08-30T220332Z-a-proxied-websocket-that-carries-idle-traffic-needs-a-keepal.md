---
recorded: 2026-08-30T22:03:32Z
incident_date: 2026-08-30
commit: 1e5b55ed22
---
# A proxied WebSocket that carries idle traffic needs a keepalive YOU send

**When:** you proxy a WebSocket through `apps/api` (the PTY terminal, an app
preview socket, anything on `/v1/p/.../connect`). Every hop between the API and a
sandbox drops a connection with no bytes on it, and a terminal is idle by nature
— a shell at its prompt emits nothing and a reader types nothing. Measured on a
real Platinum box, the API->sandbox leg dies at **exactly 60 s** of silence.

`websocket.idleTimeout: 0` on both Bun servers does NOT cover this: it governs
neither the provider edge nor the API's own upstream client. And on a PTY you
cannot keep the leg busy with data — an upstream byte is typed into the user's
shell, a downstream byte is printed into their terminal. **Send a PING control
frame on BOTH legs, well under the shortest hop timeout, and clear the interval
on every close path** (`PREVIEW_WS_KEEPALIVE_MS`, `pingPreviewWsLegs`).

**Diagnosing a WS that dies on a timer:** a browser reports every drop as `1006`
with no detail, so instrument from a Bun client instead and run three arms on ONE
sandbox in ONE minute — no keepalive, PING, DATA. A ping terminates at the API,
so `PING dies / DATA survives` proves the cut is on the UPSTREAM leg; the reverse
proves it is on the client leg. Guessing at ALB/Cloudflare timeouts from the
outside is how this stayed unexplained.

*Incident:* PR #7062. Terminals reconnected once a minute on dev, staging AND
prod ("not connecting anymore, basically EVERY time"), rendered as
`Reconnecting in Ns (code 1006)`. Root cause reproduced on the LOCAL stack with
no Cloudflare and no ALB in the path, which is what ruled out the edge.
*Enforcer:* `apps/api/src/sandbox-proxy/ws-proxy-keepalive.test.ts` pins that both
legs are pinged, that one leg throwing does not skip the other, and that the
interval clears the measured 60 s cut twice over. There is still NO end-to-end
coverage of the PTY WebSocket in `tests/` — `grep -rn "kortix/pty" tests/` was
empty before this incident, which is why a socket that died every 60 s on every
environment shipped unnoticed.
