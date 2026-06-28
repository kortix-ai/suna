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

Cold provisioning and warm-pool claim must mint the same shape of token. The token is unique per session; a claimed warm sandbox must never keep a project-only token from its parked state.

`/accounts/me` exposes this as `token_context` so CLI and debugging surfaces can say whether the active credential is a user, project, or session token and show its agent/connector/Kortix CLI grant.

## Agent Switching Policy

The executor credential is bound to the session boot agent. A prompt that explicitly asks OpenCode to run a different agent inside the same running sandbox is rejected by the API proxy before the request reaches OpenCode. This prevents a switched agent from inheriting the original agent's connector or Kortix CLI grant.

The supported secure flow for a different agent is to start a new session with that agent selected. A future per-turn token model may relax this, but it must mint and inject a new executor token per requested agent before the prompt reaches tool execution.

## CLI Behavior

`kortix token` is an identity probe, not a project scaffold name. It aliases `kortix whoami --token-only` and prints the active token context. Inside a sandbox, the host banner must say `authenticated (session token)` when `KORTIX_SESSION_ID` is present.

The CLI auth order remains:

1. `KORTIX_CLI_TOKEN`
2. `KORTIX_EXECUTOR_TOKEN`
3. stored host auth

`KORTIX_TOKEN` is intentionally excluded from CLI auth resolution.
