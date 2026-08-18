# Token, Session, and Agent Identity Model

## Principals

Kortix sandboxes carry two different credentials with different principals.

1. Sandbox service credential: `KORTIX_SANDBOX_TOKEN` with legacy alias `KORTIX_TOKEN`.
   This authenticates API-to-daemon control-plane calls, signed user context, clone credentials, turn relays, and proxy plumbing. The CLI must not treat it as a user token.

2. Session connector credential: `KORTIX_CLI_TOKEN`.
   This is a Kortix account token acting as the launching user, scoped to exactly one project and, for real sandbox sessions, exactly one session. It is the only token the agent-facing CLI and Connector SDK should use.

3. User/account PAT: a laptop or automation token without `session_id`.
   It can be account-wide or project-scoped depending on `project_id`, and is governed by normal IAM plus PAT lifecycle policy.

4. Service-account token: non-human IAM principal for API access. It is separate from sandbox service credentials and is not injected into agent sandboxes.

## Session Connector Token Contract

A sandbox session connector token must include:

- `project_id`: the owning project.
- `session_id`: the project session id, equal to the sandbox id.
- `agent_grant`: the resolved grant for the session boot agent from `[[agents]]`.
  The proxy re-mints this field before every prompt from the agent that actually
  runs. See **Agent Switching Policy**.

Cold provisioning and restored warm-snapshot sessions must mint the same shape of token. The token is unique per session; a restored session must never keep a project-only token from its seed capture.

`/accounts/me` exposes this as `token_context` so CLI and debugging surfaces can say whether the active credential is a user, project, or session token and show its agent/connectors/Kortix CLI grant.

## Agent Switching Policy

A prompt may ask OpenCode to run a **different concrete agent** inside the same running sandbox. The API proxy allows it and re-scopes the session before the request reaches OpenCode. Three steps run per prompt, in order:

1. Authorize the switch. The caller must hold `project.agent.read` on the agent the prompt names. Otherwise the proxy returns `403 AGENT_NOT_AUTHORIZED`.
2. Re-push the secret env for the running agent (`syncSandboxEnvForPrompt`). An unreadable `[[agents]]` manifest fails closed with `503 AGENT_SECRET_GRANT_UNRESOLVED`.
3. Re-mint the session token's `agent_grant` from the running agent's manifest block (`remintGrantForAgentSwitch`). A failed re-mint returns `503 AGENT_SWITCH_GRANT_UNAPPLIED`.

A switched agent therefore never inherits the boot agent's connector or Kortix CLI grant: both are checked against `account_tokens.agent_grant` at call time, and step 3 rewrites that row.

Secrets are the exception. Step 2 changes future delivery only. It cannot un-read a value the previous agent already read into its shell or its context.

Known limit (`session-token-grant.ts:200-206`): two concurrent prompts that name different agents on one `session_id` race on the single token row, and the last writer wins. The loser's agent then runs under the winner's grant for that turn. The single-prompt path — every ordinary session — is correct.

### The `default` sentinel is non-binding

`project_sessions.agent_name` defaults to the literal string `default`, and no agent is ever named `default` — it is a placeholder that the runtime resolves to OpenCode's configured `default_agent` (conventionally `kortix`). Because the session actually *runs* as that general-purpose default agent (granted `"all"`), the **grant resolution must resolve `default` the same way the proxy and the runtime do**: a `default` session carries the configured `default_agent`'s grant. When no concrete `default_agent` is declared in `[[agents]]`, the sentinel is **non-binding → `null`** (full access, still capped at the launching user's role — identical to a project that never adopted `[[agents]]`). It must **not** be treated as an unlisted concrete agent (default-deny): doing so stripped every connector from `default`-booted sessions — `kortix connectors ls` returned `[]` and synthetic `channel`/`computer` connectors never reached the agent — even though OpenCode runs them as the fully-privileged default agent (`grantFromLoadedAgents`, `apps/api/src/projects/agents.ts`). A project locks its default down by setting `default_agent` to a **concrete** declared agent, which then arrives by that name and gets its (possibly narrow) grant. There is no agent-specific grant for a *switch* to inherit.

Consequently the proxy treats `default` as non-binding on **either** side of the comparison:

- A prompt whose `agent` is `default`, or which omits `agent`, is never a switch.
- A session whose bound agent is `default` never treats a prompt's `agent` as a switch, whatever concrete name it carries.
- `isConcreteAgentSwitch` (`sandbox-proxy/routes/preview.ts`) recognises a switch **only** when the session is bound to a concrete (non-`default`) agent *and* the prompt requests a *different* concrete agent.

That predicate now gates the authorization check, not a refusal. A prompt it does not recognise as a switch skips the `project.agent.read` check and runs the session's own agent.

For a `default` session the proxy also strips the prompt's `agent` field before forwarding, so OpenCode always runs the agent the session actually booted with (`default_agent` = the agent the connector token was minted for), regardless of which concrete name the client speculatively echoed.

This is required for correctness, not just leniency: the web client resolves "the default" to a concrete agent name for display and echoes it back on follow-up turns, and a first-turn race can send that name before the session's bound agent has loaded. A literal `requested !== stored` comparison turned that ordinary echo into a bogus `AGENT_SWITCH_REQUIRES_NEW_SESSION` 409 on the second message of essentially every new session (the 409 has since been removed entirely).

## CLI Behavior

`kortix token` is an identity probe, not a project scaffold name. It aliases `kortix whoami --token-only` and prints the active token context. Inside a sandbox, the host banner must say `authenticated (session token)` when `KORTIX_SESSION_ID` is present.

The CLI auth order remains:

1. `KORTIX_CLI_TOKEN` from the process environment
2. `KORTIX_CLI_TOKEN` from `/dev/shm/kortix/agent-env.sh`
3. stored host auth

`KORTIX_TOKEN` is intentionally excluded from CLI auth resolution.
