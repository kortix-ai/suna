# ACP and Multi-Harness Design

## Scope

The project experiment `experimental.acp_runtime` controls one product feature.

- Disabled: sessions use the existing OpenCode REST compatibility transport.
- Enabled: sessions use ACP and can select OpenCode, Claude Code, Codex, or Pi.

The implementation does not add a second harness experiment.

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
