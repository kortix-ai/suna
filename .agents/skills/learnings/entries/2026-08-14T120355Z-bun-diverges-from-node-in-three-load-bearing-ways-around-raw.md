---
recorded: 2026-08-14T12:03:55Z
incident_date: 2026-08-14
commit: 55b03fe2ca
---
# Bun diverges from Node in three load-bearing ways around raw sockets and TLS

**When:** writing socket/TLS code that runs under Bun (the API and the sandbox
daemon both do). Measured, bun 1.3.14 vs node v22.22.0:

- `http.Server.emit('connection', socket)` is a **no-op** — the request event
  never fires and the connection hangs with nothing in any log. Use a real
  loopback listener and pipe into it.
- `SNICallback` **never fires** — the handshake completes against a default
  certificate. Bind one static-cert listener per terminated host instead.
- The `'upgrade'` event fires, but a write from that handler **never reaches the
  client**; Node delivers the same bytes. Destroy the socket rather than trying
  to answer.

All three fail SILENTLY (a hang, or the wrong certificate), never an exception.
*Incident:* each cost a debugging cycle in the egress proxy/shim.
