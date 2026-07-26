# Agent-scoped secret injection

**Date:** 2026-07-26
**Status:** Implemented
**Area:** `apps/api` — project secrets → sandbox env

## Problem

A project's secrets are injected into a session's sandbox as plain env vars. Which
secrets an agent receives is gated by exactly one thing: the `secrets` grant its
agent declares in `kortix.yaml` (`sessions.ts` — *"This is the ONLY gate on agent
secret access — there is no resource-side allow-list on the secret itself"*).

Two paths perform that injection, and they had drifted:

| | Boot | Per-prompt hot push |
|---|---|---|
| Entry point | `buildSessionSandboxEnvVars` | `resolveOwnerRawEnv` |
| Principal used | `input.agentName` | `project_sessions.agent_name` |
| Loader failure | `.catch(() => null)` → unrestricted | `.catch(() => null)` → unrestricted |

Three defects followed.

### 1. Fail-open on grant-resolution failure

Both call sites wrapped `loadProjectAgents` in `.catch(() => null)`. A `null`
result produced `agentGrantEnv = undefined`, which
`listProjectSecretsSnapshotForUser` interprets as **all secrets**. Any throw from
the loader — not the manifest-parse errors it handles internally, but a genuine
failure of the loader itself — silently widened the session to every project
secret, with no error anywhere.

### 2. The grant was resolved from the wrong agent

`project_sessions.agent_name` records the agent a session was **created** with.
Nothing in the codebase ever updates that column (verified: the only `agentName`
write is on `chat_channel_bindings`).

Meanwhile in-session agent switching is permitted. `KORTIX_ENFORCE_SESSION_AGENT_LOCK`
defaults off, and the proxy forwards a concrete `agent` field untouched
(`preview.ts` — *"a prompt may freely run a different agent"*).

So the hot push resolved the grant from a stale column on every turn:

```
create session with agent A (secrets: all)   → sandbox env = ALL project secrets
prompt {"agent": "B"}  where B has secrets: [NARROW_KEY]
  → opencode runs B
  → env sync resolves grant from A → re-pushes ALL secrets
  → B executes with A's full credential set
```

Agent B's declared `secrets` grant was never enforced when B was reached by
switching rather than by session creation. The inverse (narrow → broad) is a
functional bug: the broad agent runs under-provisioned with no error.

### 3. Duplicated policy

The same resolution logic existed twice, in subtly different forms. Any future
fix had to be applied to both or they would drift again.

## Design

### One resolver

`apps/api/src/projects/lib/secret-grant.ts` is now the single place a session's
secret grant is resolved. Both boot and hot push call
`resolveSessionSecretGrant`. The policy lives in pure, separately-tested helpers
(`effectiveRunningAgent`, `secretGrantEnvDiffers`, `secretGrantEnvForRunningAgent`);
only the manifest load is I/O.

### Fail closed

Loader failure now throws `SecretGrantResolutionError` instead of collapsing to
an unrestricted grant.

- **Boot** — the provision fails. A session that cannot prove what it may read is
  not created.
- **Hot push** — the prompt fails with `503 AGENT_SECRET_GRANT_UNRESOLVED`. 503,
  not 502, because it is a transient inability to *verify*, and retrying is the
  correct client response.
- **Background fan-out** (`propagateProjectSecretsToActiveSandboxes`) — the
  per-row `try/catch` logs and skips. The sandbox keeps its existing, narrower
  env; it is never widened.

### Resolve from the running agent

`syncSandboxEnvForPrompt` now takes `requestedAgent` — the prompt's own `agent`
field, threaded from `preview.ts` — and resolves the grant from
`effectiveRunningAgent(requestedAgent, sessionAgent)`.

The `'default'` sentinel is non-binding on the request side (the proxy strips it
so OpenCode resolves its own `default_agent`), so it maps to the session's agent
rather than triggering a fresh sentinel lookup. Without that, every ordinary turn
on a concretely-bound session would recompute its grant against `'default'`.

### Refuse a grant-changing switch

Re-scoping the env on a later turn **cannot undo the disclosure**. By the time a
switch is observed, the previous agent's secrets are already in
`/dev/shm/kortix/agent-env.sh`, exported into every shell it spawned, and in its
own context. Narrowing the next push does not retract any of that.

So a switch whose `secrets` grant differs from the session's is refused:
`AgentSecretGrantMismatchError` → the existing
`409 AGENT_SWITCH_REQUIRES_NEW_SESSION`.

This is deliberately **narrower than `KORTIX_ENFORCE_SESSION_AGENT_LOCK`**, which
409s on any name change and is gated off precisely because it false-positived on
ordinary flows. Switching between agents with the *same* grant stays free, so
this reintroduces none of that breakage.

The web client is unaffected: it already treats sessions as agent-immutable and
binds the agent at creation (`new-session-create.ts`, `use-new-project-session.ts`),
documenting the 409 as expected behavior.

### Kill switch

`KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK` (default **on**). Turning it off
degrades to re-scoping onto the *running* agent's grant — it does **not** restore
resolution from the stale create-time column. Enforcement off trades the hard
refusal for a soft narrowing; the original widening is not reachable either way.

## Files

| File | Change |
|---|---|
| `projects/lib/secret-grant.ts` | New — the single resolver + pure policy |
| `projects/lib/secret-grant.test.ts` | New — 24 tests |
| `projects/lib/sessions.ts` | Boot uses the shared resolver; no `.catch(() => null)` |
| `projects/lib/sandbox-env-sync.ts` | Hot push resolves from the running agent |
| `sandbox-proxy/routes/preview.ts` | Threads `requestedAgent`; maps errors to 409 / 503 |
| `config.ts` | `KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK` |

## Not in scope

**Gateway-only secrets.** A BYOK key connected through the LLM Providers modal is
written to `project_secrets` and therefore also injected into the sandbox, where
the agent can read it with `echo $ANTHROPIC_API_KEY`. In gateway mode the daemon
withholds it from the *opencode process* (`KORTIX_OPENCODE_DENY_ENV`) so routing
stays on the gateway, but that is a routing control, not a secrecy control — the
container still holds the key.

Closing that requires a third `project_secrets.scope` value (`'runtime'` |
`'connector'` | `'gateway'`) so the key stays readable by
`getProjectSecretValue` server-side while being excluded by `sanitizeSandboxEnv`.
That needs a migration, an API-contract change, and UI, so it is a separate
change from this one.

**Subagent fan-out.** An agent that spawns subagents inside OpenCode never
crosses the proxy, so those inherit the session's env regardless of what the
subagent declares. Scoping that requires per-subagent env isolation inside the
sandbox, not a server-side gate.
