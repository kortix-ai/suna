# ACP and Multi-Harness Design

> **Not shipped — reverted on 2026-07-30.** ACP and multi-harness
> (`kortix_version: 3`, Claude Code / Codex / Pi) are experimental, unreleased,
> and off by default (`KORTIX_ACP_RUNTIME=false`). OpenCode REST +
> `kortix_version: 2` are the shipped default. Read this file as a historical
> record, not as current product guidance.

## Scope

The project experiment `experimental.acp_runtime` controls one product feature.

- Disabled: sessions use the existing OpenCode REST compatibility transport.
- Enabled: sessions use ACP and can select OpenCode, Claude Code, Codex, or Pi.

The implementation does not add a second harness experiment.

## Enablement (current, 2026-07-30)

ACP is experimental and OFF by default. The whole switch is one variable.

| Knob | Kind | Default | Read at |
|---|---|---|---|
| `KORTIX_ACP_RUNTIME` | operator env | `false` | `experimental/features.ts` — the `acp_runtime` `platformDefault()` |
| `experimental.acp_runtime` | per-project (`projects.metadata`) | absent | `resolveExperimentalFeature()` |
| `KORTIX_ENABLED_HARNESSES` | operator env | empty = stable set (`opencode`) | `projects/lib/harness-gate.ts` |

Resolution: the project's explicit choice wins over `KORTIX_ACP_RUNTIME`;
`resolveProjectRuntimeTransport()` has no other input. The feature stays
`available: () => true` so a project can hold an opinion even while the fleet
default is off — otherwise every project already on ACP, including v3-manifest
projects that cannot run REST, would silently fall back and break.

`POST /projects/provision` and `POST /projects/create-repo` write NO
`experimental` block. This matches `origin/prod`, where
`git show origin/prod:apps/api/src/projects/routes/r1.ts | grep acp_runtime`
returns nothing. A new project states no opinion and follows the fleet default.

v3 acceptance follows the same switch. `projects/lib/acp-runtime-gate.ts`
refuses a v3 starter scaffold with `409 ACP_RUNTIME_DISABLED` while
`KORTIX_ACP_RUNTIME` is off, before any upstream repo or DB row exists. v3 is
therefore not scaffolded, not defaulted to (the default starter is
`general-knowledge-worker`, `kortix_version: 2`), and not offered as a migration
target (`MIGRATIONS` in `projects/lib/manifest-verdict.ts` holds only `1 -> 2`).
A repo that declares v3 itself still parses; it refuses at session create with
`409 ACP_RUNTIME_REQUIRED`.

`KORTIX_ACP_RUNTIME` does not change the sandbox process:
`KORTIX_OPENCODE_PROCESS_TRANSPORT` stays pinned to `acp`
(`projects/lib/sessions.ts`), and both client transports reach that one process.

Removed: `KORTIX_OPENCODE_TRANSPORT`. It was a second operator knob that forced
ACP fleet-wide and overrode an explicit per-project `false`.

## Manifest contract

`kortix_version: 3` defines runtime profiles and logical agents.

```yaml
kortix_version: 3
default_agent: kortix

runtimes:
  opencode:
    harness: opencode
    config_dir: .kortix/opencode
  claude:
    harness: claude
    config_dir: .claude
  codex:
    harness: codex
    config_dir: .codex
  pi:
    harness: pi
    config_dir: .pi

agents:
  kortix:
    runtime: opencode
  claude:
    runtime: claude
  codex:
    runtime: codex
  pi:
    runtime: pi
```

Kortix owns agent-to-runtime routing and governance.

Each harness owns prompts, models, providers, hooks, and permissions in its
native config directory.

Versions 1 and 2 keep their existing OpenCode behavior.

## Session identity

The implementation keeps three identities separate.

| Identity | Owner | Lifetime |
| --- | --- | --- |
| `project_session_id` | Kortix API | Durable across runtime replacement |
| `acp_server_id` | Sandbox daemon | One managed harness process |
| `acp_session_id` | Harness | One native conversation |

For managed harnesses, `acp_server_id` equals `project_session_id`.

For Claude Code, Codex, and Pi, `acp_session_id` comes from `session/new`.

The SDK builds the ACP HTTP endpoint with `acp_server_id`.

The SDK sends ACP methods with `acp_session_id`.

The API stores the immutable harness binding and both ACP identities in session
metadata.

## Session creation

The API resolves the requested logical agent before it inserts the session.

The selected logical agent fixes these values:

- `agent_name`
- `runtime_name`
- `runtime_harness`
- `native_agent`
- `runtime_transport`

The API rejects a non-OpenCode harness when `acp_runtime` is disabled.

The API rejects a later request that changes the session agent or harness.

Two sessions in one project can select different logical agents and harnesses.

## Runtime boot

The API injects a runtime-neutral launch plan and selected harness fields.

The sandbox daemon keeps OpenCode REST available for compatibility projects.

For an ACP multi-harness session, the daemon starts the selected managed
harness under `acp_server_id`.

The ACP HTTP bridge selects the process by `acp_server_id`.

The bridge passes `acp_session_id` unchanged in ACP payloads.

## SDK

`useSession(projectId, sessionId)` remains the only host lifecycle hook.

The SDK reads the server-selected transport, harness, server ID, and protocol
session ID from project-session responses.

The ACP controller initializes the managed harness once.

It loads a stored `acp_session_id` or creates a new native session.

The SDK persists a newly created `acp_session_id` through the project-session
API before it sends the first prompt.

## Web and headless callers

The project config response includes each logical agent's runtime and harness.

The agent selector shows the harness label when `acp_runtime` is enabled.

The create request sends only the logical `agent_name`.

Triggers, schedules, Slack, email, Telegram, Teams, webhooks, CLI, SDK, and web
all use the same session-create preflight.

Headless follow-up delivery uses ACP for ACP sessions.

## Compatibility

- No existing exported SDK name is removed or renamed.
- No host constructs ACP runtime URLs.
- No app imports an ACP adapter.
- No project without `acp_runtime` changes transport.
- No v1 or v2 manifest changes validation or compilation behavior.
