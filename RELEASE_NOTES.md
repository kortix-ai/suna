Instant session shell, per-agent access, and a faster colocated backend

**New**
- **Per-agent authorization** — scope exactly what each agent can touch with `[[agents]]` in `kortix.toml`.
- **Instant session shell** — sessions open immediately with an optimistic create and a shared composer, so there's no wait to start working.

**Improved**
- Project home, configure, and composers now route through the instant shell for a snappier first interaction; workspace top bar refresh and background restored.
- **Warm pool is now per-template opt-in** (no global cap) — templates that benefit from pre-warmed sandboxes get them without tying up capacity for those that don't.
- **The production backend now runs colocated with the database (London)**, cutting cross-region latency on every request.

**Fixed**
- Slack: exactly-once turn dispatch and durable, atomic credit deduction — no more double answers or missed credits.
- Terminal: fixed a PTY WebSocket reconnect loop when a JWT expired.
- Warm pool: send the Daytona preview token on the park health probe.
