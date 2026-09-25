---
recorded: 2026-08-14T17:15:25Z
incident_date: 2026-08-11
commit: 83ea8690d6
---
# Two proxy layers must agree on which upstream calls legitimately block

**When:** changing a timeout in `kortix-sandbox-agent-server/src/proxy.ts` or
`apps/api/src/sandbox-proxy/`, or adding an OpenCode endpoint that withholds
headers until its work completes.
The daemon bounded EVERY proxied header wait at `UPSTREAM_RESPONSE_TIMEOUT_MS =
10_000`, reasoning only about SSE (headers arrive fast) and a wedged opencode.
`POST /session/:id/command` emits nothing until the whole turn finishes, so
every command over 10s was aborted and answered `502 {"error":"upstream
unreachable"}` — the banner users saw in chat, on a healthy turn. Its own
comment said the 502 exists so "apps/api's retry+auto-wake loop can act on it
immediately" — and that loop assumed idempotency. **A fail-fast designed to
trigger a retry met a retry loop that assumed it was safe to repeat.** One
`/webapp` submit ran the agent four times, each retry aborting the turn the
previous one started, which is where the "Interrupted" labels came from.
**Rules:** (1) a header-wait timeout is only valid for endpoints that ANSWER
fast — blocking-turn endpoints need their own generous bound
(`isBlockingTurnRequest` / `LONG_TURN_RESPONSE_TIMEOUT_MS`); (2) when one layer
fails fast *expecting* another to retry, the retry decision must be written down
in both layers, never inferred; (3) a client must not render a
delivered-then-disconnected prompt as a failed send — the retry it invites is
what aborts the live turn (`delivered-but-disconnected.ts`).
**Enforcement:** `blocking-turn-timeout.test.ts` drives BOTH layers' predicates
with the same inputs and requires identical verdicts (verified falsifiable — it
goes red when either side drifts).
**Deployment trap:** the daemon ships inside the sandbox image, so this fix
reaches only sandboxes created from a NEW snapshot. Existing sessions keep the
10s bound; the web-side classifier is what covers them.
*Incident:* session `9f6b0d87`.
