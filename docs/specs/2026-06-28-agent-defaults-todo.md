# TODO — Agent selection follow-ups (deferred 2026-06-28)

Context: the session **agent-lock enforcement** (the preview proxy's
`AGENT_SWITCH_REQUIRES_NEW_SESSION` 409) was **deactivated** — gated behind
`KORTIX_ENFORCE_SESSION_AGENT_LOCK`, default **off** — so in-session agent
switching works and new sessions don't fail their first prompt. Two follow-ups
were intentionally deferred:

## 1. Re-enable agent-lock the right way (auth/authz)

The lock existed to bind a session's **executor token** to one agent, so a
switched agent can't inherit the boot agent's connector / Kortix-CLI grant. The
correct model is **per-turn token re-mint**: when a prompt asks for a different
agent, mint + inject a new executor token scoped to *that* agent's grant before
the prompt reaches tool execution — then flip `KORTIX_ENFORCE_SESSION_AGENT_LOCK`
back on (or retire it for the per-turn path). Until that exists, enforcement
stays off. See `docs/specs/2026-06-28-token-session-agent-identity.md`.

## 2. Default new-session settings (agent + model) — the real UX fix

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

Net effect once both land: a new session boots the user's chosen default agent;
switching mid-session is free (enforcement off); and the auth model (item 1) can
re-introduce safe per-agent scoping without the false positives.
