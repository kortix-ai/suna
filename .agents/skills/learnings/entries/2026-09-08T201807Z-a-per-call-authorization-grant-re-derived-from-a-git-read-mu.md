---
recorded: 2026-09-08T20:18:07Z
incident_date: 2026-09-08
commit: 45357b024d
---
# A per-call authorization grant re-derived from a git read must carry provenance, or one bad read is a session-wide outage

INC-2026-09-08-CONNECTOR-GATEWAY, prod project `fda4e35e` (Kortix Company),
Slack DM session `673b4639`. Every connector call re-derived the session
token's agent grant from `kortix.yaml` through a forced mirror fetch and
REPLACED the token row whenever the result differed. One turn's reads produced
`connectors: []` for an agent declared `connectors: all`; the token was
rewritten, and for 10 minutes every connector — Slack included — answered
`connector_not_assigned`. The agent could not even report the failure. The
same project had 59 such denials in the previous week. No git error was ever
logged: the read "succeeded" with the wrong content. The repository had no
`kortix` agent before 2026-08-01, so any stale ref or wrong blob resolves that
agent to deny-all.

**The rule.** A grant stored on a credential is replaced only by a grant whose
provenance proves a genuine change. Stamp the manifest blob sha and commit on
every derived grant. Same blob, different grant = a glitched read: confirm with
a second read before applying, never on one read. A commit that is an
ancestor of the stored grant's commit = a stale mirror: never applies. An
unreadable manifest on a per-call path serves the stored grant
(last-known-good) and logs; only a credential with nothing stored fails
closed. The channel that created a session stays callable under any grant,
so the agent is never mute. A denial says which agent, what it holds, and
which manifest revision that came from.

**Corollary for honest relays.** A sandbox helper must never collapse an HTTP
failure into "no turn" (`catch { return false }`) or print `ok: true` for an
undelivered progress step. `slack step` streamed a whole run into nothing and
the agent believed it was seen.

*Fix:* PR `connector-gateway-outage` — `AgentGrant.manifestRevision` /
`manifestCommit`, `remintDecisionFor` keep rules + confirming re-read,
last-known-good in `reconcileStoredSessionAgentGrant`, a 3 s forced-refresh
cooldown on the gateway path, `principalMayUseConnector` (originating channel
allowance), `connectorDenialBody`, `connector_not_connected` +
`needs_auth` for credential-less connectors, `{ok:false, reason}` from
`turn-stream`, non-zero `slack step`/`slack send` with the reason, a 20 s
idle-end grace so a replayed `session.idle` cannot delete a fresh Slack turn,
and turn-end relay skipped on `identity_mismatch`. *Enforcer:*
`apps/api/src/projects/lib/session-token-grant-provenance.test.ts` (same-blob
drift, stale commit, unreadable manifest, cooldown),
`apps/api/src/connectors/principal-access.test.ts`, and flow `CONN-27`
(a real session-bound token: hot reload with provenance, glitch repair,
channel guarantee, honest denials, ten calls after a mid-session add).
