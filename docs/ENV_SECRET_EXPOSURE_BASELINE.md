# Secret exposure inside a Kortix sandbox — verified baseline

**Status:** statement of *current* behaviour on `main`, as of 2026-07-28. No
proposal here. This exists so the env-var refactor argues from measured facts
rather than from what the architecture is assumed to do.

**Harness scope:** The `KORTIX_OPENCODE_DENY_ENV` findings below apply to the
OpenCode compatibility child. Claude Code, Codex, and Pi ACP launch environments
are resolved separately in `acp/harness-registry.ts`. All four harnesses still
run inside the same session sandbox, so sandbox-level secret exposure remains
the shared boundary.

Every claim below is anchored to code I read on `main`. Where the codebase
already documents its own intent, that comment is quoted rather than paraphrased
— several of these are deliberate decisions, not oversights, and the refactor has
to overturn a decision rather than fix a bug.

## The one-sentence version

Every project secret an agent is granted is present in its sandbox's process
environment, readable by any command the agent runs; the LLM gateway's
"deny" mechanism narrows only what *OpenCode* sees, not what the box holds.

## 1. Granted project secrets are injected into the sandbox environment

`buildSessionSandboxEnvVars` ([sessions.ts](../apps/api/src/projects/lib/sessions.ts))
resolves the session's secrets and returns them spread into the env map handed
to the provider at boot:

```ts
return {
  ...runtimeSecrets.env,
  ...channelEnv,
  ...sessionContextEnv,
  KORTIX_PROJECT_SECRET_NAMES: runtimeSecrets.names.join(','),
  ...
```

The set is already narrowed three ways — project secrets ∩ the agent's `secrets`
grant ∩ the per-session `secrets` allowlist — and reserved names are dropped. All
of that governs **which** secrets are injected. None of it changes the fact that
whatever survives is injected *as environment*.

The same set is re-pushed on every prompt by
[sandbox-env-sync.ts](../apps/api/src/projects/lib/sandbox-env-sync.ts), so
narrowing later does not remove what an earlier turn already placed in the box.

## 2. Provider API keys reach the sandbox **by design**

This is the founder's specific complaint, and it is not an accident. From
`sessions.ts` immediately above the deny-list:

> `// Provider API keys reach the sandbox (the agent's own code may use them),`
> `// but opencode must NOT — a provider key in opencode's env makes it connect`
> `// a NATIVE provider and bypass the gateway.`

So `KORTIX_OPENCODE_DENY_ENV` exists to protect **gateway routing** (spend,
budgets, logs), not to protect the **secret**. The stated rationale for the
secret still being present — *"the agent's own code may use them"* — is exactly
the assumption a per-secret strategy model has to make opt-in.

## 3. The deny-list strips from OpenCode's child process, not from the box

[opencode.ts](../apps/kortix-sandbox-agent-server/src/opencode.ts), which says so
itself:

```ts
const denyEnv = (env.KORTIX_OPENCODE_DENY_ENV || '').split(',')...
for (const name of denyEnv) { if (name in env) { delete env[name]; withheld++ } }
```

> `// This only touches the opencode process env; it doesn't change what the`
> `// container itself holds.`

Any shell command the agent runs — `env`, `printenv`, `cat /proc/1/environ`, a
Python script — is a sibling of that child process, not a descendant of the
stripped env. The variables are still there.

## 4. `stripGatewayManagedCredentials` is dead code

[sandbox-credentials.ts](../apps/api/src/llm-gateway/sandbox-credentials.ts)
exports a function that removes gateway-managed provider credentials from an env
map. Repo-wide, its only occurrence is its own definition — it is never called:

```
$ grep -rn "stripGatewayManagedCredentials" --include='*.ts' apps packages
apps/api/src/llm-gateway/sandbox-credentials.ts:39:export function stripGatewayManagedCredentials(...)
```

This is worse than the leak itself: a reviewer scanning for "do we strip
credentials before handing env to the sandbox?" finds a function whose name says
yes. Whatever the refactor decides, this must end as either wired or deleted.

## 5. On-disk exposure is thoughtfully handled — and irrelevant to this threat

[agent-env-file.ts](../apps/kortix-sandbox-agent-server/src/agent-env-file.ts)
writes the agent env to `/dev/shm/kortix` at mode `0600`, verifies `/dev/shm` is
a real tmpfs, and shreds the file — specifically so a hibernated or archived
Daytona disk cannot retain plaintext.

That is good work against *disk capture*. It does nothing against the threat that
matters here: the agent runs **as the user that can read those 0600 files**.

## 6. Why this blocks Kortix-as-a-Backend specifically

In KaaB one wrapper account fronts many end-users on one repo and one agent. The
agent's input is end-user-controlled text, so prompt injection is not a risk to
be mitigated — it is the normal operating condition. Any secret in the box is
therefore reachable by any end-user of the wrapper.

That is why the founder's framing is right: today Kortix's env handling is safe
for *trusted internal users* and not for a multi-tenant backend.

## What is NOT claimed here

- That the narrowing (agent grant, session allowlist, reserved-name drop) is
  broken. It is not; it is tested and it works. It narrows *which* secrets are
  exposed, not *whether* they are.
- That connectors leak. They do not — the connector broker resolves third-party
  credentials server-side and they never enter the sandbox
  ([executor](../apps/api/src/executor)). That is the prior art the refactor
  should generalise.
- That any specific design is correct. This document deliberately stops before
  the proposal.
