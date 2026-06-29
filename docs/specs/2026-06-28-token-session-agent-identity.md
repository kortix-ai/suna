# Token, Session, and Agent Identity Model

## Principals

Kortix sandboxes carry two different credentials with different principals.

1. Sandbox service credential: `KORTIX_SANDBOX_TOKEN` with legacy alias `KORTIX_TOKEN`.
   This authenticates API-to-daemon control-plane calls, signed user context, clone credentials, turn relays, and proxy plumbing. The CLI must not treat it as a user token.

2. Session executor credential: `KORTIX_EXECUTOR_TOKEN` with compatibility alias `KORTIX_CLI_TOKEN`.
   This is a Kortix account token acting as the launching user, scoped to exactly one project and, for real sandbox sessions, exactly one session. It is the only token the agent-facing CLI and Executor SDK should use.

3. User/account PAT: a laptop or automation token without `session_id`.
   It can be account-wide or project-scoped depending on `project_id`, and is governed by normal IAM plus PAT lifecycle policy.

4. Service-account token: non-human IAM principal for API access. It is separate from sandbox service credentials and is not injected into agent sandboxes.

## Session Executor Token Contract

A sandbox session executor token must include:

- `project_id`: the owning project.
- `session_id`: the project session id, equal to the sandbox id.
- `agent_grant`: the resolved grant for the session boot agent from `[[agents]]`.

Cold provisioning and restored warm-snapshot sessions must mint the same shape of token. The token is unique per session; a restored session must never keep a project-only token from its seed capture.

`/accounts/me` exposes this as `token_context` so CLI and debugging surfaces can say whether the active credential is a user, project, or session token and show its agent/connector/Kortix CLI grant.

## Agent Switching Policy

The executor credential is bound to the session boot agent. A prompt that explicitly asks OpenCode to run a **different concrete agent** inside the same running sandbox is rejected by the API proxy before the request reaches OpenCode. This prevents a switched agent from inheriting the original agent's connector or Kortix CLI grant.

The supported secure flow for a different agent is to start a new session with that agent selected. A future per-turn token model may relax this, but it must mint and inject a new executor token per requested agent before the prompt reaches tool execution.

### The `default` sentinel is non-binding

`project_sessions.agent_name` defaults to the literal string `default`, and no agent is ever named `default` — it is a placeholder that the runtime resolves to OpenCode's configured `default_agent` (conventionally `kortix`). Because the session actually *runs* as that general-purpose default agent (granted `"all"`), the **grant resolution must resolve `default` the same way the proxy and the runtime do**: a `default` session carries the configured `default_agent`'s grant. When no concrete `default_agent` is declared in `[[agents]]`, the sentinel is **non-binding → `null`** (full access, still capped at the launching user's role — identical to a project that never adopted `[[agents]]`). It must **not** be treated as an unlisted concrete agent (default-deny): doing so stripped every connector from `default`-booted sessions — `kortix executor connectors` returned `[]` and synthetic `channel`/`computer` connectors never reached the agent — even though OpenCode runs them as the fully-privileged default agent (`grantFromLoadedAgents`, `apps/api/src/projects/agents.ts`). A project locks its default down by setting `default_agent` to a **concrete** declared agent, which then arrives by that name and gets its (possibly narrow) grant. There is no agent-specific grant for a *switch* to inherit.

Consequently the proxy treats `default` as non-binding on **either** side of the comparison:

- A prompt whose `agent` is `default`, or which omits `agent`, is never a switch.
- A session whose bound agent is `default` never rejects a prompt's `agent`, whatever concrete name it carries.
- A switch is rejected **only** when the session is bound to a concrete (non-`default`) agent *and* the prompt requests a *different* concrete agent.

For a `default` session the proxy also strips the prompt's `agent` field before forwarding, so OpenCode always runs the agent the session actually booted with (`default_agent` = the agent the executor token was minted for), regardless of which concrete name the client speculatively echoed.

This is required for correctness, not just leniency: the web client resolves "the default" to a concrete agent name for display and echoes it back on follow-up turns, and a first-turn race can send that name before the session's bound agent has loaded. A literal `requested !== stored` comparison turned that ordinary echo into a bogus `AGENT_SWITCH_REQUIRES_NEW_SESSION` 409 on the second message of essentially every new session.

## CLI Behavior

`kortix token` is an identity probe, not a project scaffold name. It aliases `kortix whoami --token-only` and prints the active token context. Inside a sandbox, the host banner must say `authenticated (session token)` when `KORTIX_SESSION_ID` is present.

The CLI auth order remains:

1. `KORTIX_CLI_TOKEN`
2. `KORTIX_EXECUTOR_TOKEN`
3. stored host auth

`KORTIX_TOKEN` is intentionally excluded from CLI auth resolution.
