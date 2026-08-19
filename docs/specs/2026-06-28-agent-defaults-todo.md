# TODO — Agent selection follow-ups (deferred 2026-06-28)

Context: the session **agent-lock** is **removed**. The preview proxy no longer
returns an `AGENT_SWITCH_REQUIRES_NEW_SESSION` 409, and both operator flags
(`KORTIX_ENFORCE_SESSION_AGENT_LOCK`,
`KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK`) are deleted from
`apps/api/src/config.ts`. In-session agent switching is unconditional. The
per-turn token re-mint that the lock was waiting for has shipped as
`remintGrantForAgentSwitch`; `project.agent.read` on the target agent authorizes
each switch. See `docs/specs/2026-06-28-token-session-agent-identity.md`.

One follow-up remains:

## 1. Default new-session settings (agent + model) — the real UX fix

The picker currently falls back to **the first agent in the visible list**
(alphabetical), which is usually the wrong default and gave users an "inferior
agent" on a fresh session with no control. We already have a **global default
model**; add the parallel:

- **Global default agent** — server-backed, parallel to the global default model
  (`use-model-defaults` / the gateway preference surface). New sessions fall back
  to it instead of `visibleAgents[0]`.
- **A settings gear on "New session" (hover)** — lets the user configure their
  default selected agent + default selected model for new sessions, without
  starting one first.

Net effect once this lands: a new session boots the user's chosen default agent,
and switching mid-session stays free.
