# OpenCode ACP canary

**Date:** 2026-07-25

**Status:** Historical design

This OpenCode-only canary preceded the multi-harness implementation. The active
contract is documented in
[`docs/superpowers/specs/2026-07-28-acp-multi-harness-design.md`](2026-07-28-acp-multi-harness-design.md).

## Objective

Run every interactive OpenCode session through OpenCode's native ACP server.

Keep the existing web interface and `useSession(projectId, sessionId)` contract.
Keep OpenCode REST as an explicit rollback transport during the canary.

## Required path

```text
apps/web
  -> useSession(projectId, sessionId)
  -> @kortix/sdk
  -> Kortix API proxy
  -> sandbox ACP HTTP/SSE bridge
  -> opencode acp
```

The web application must not know which runtime transport is active.

## Scope

This change supports one agent runtime:

- OpenCode through `opencode acp`.

This change supports one web interface:

- The existing `apps/web` session interface.

This change does not add a generic harness registry.

## Sandbox process contract

The sandbox agent starts `opencode acp` after repository materialization and
OpenCode configuration setup.

The sandbox agent:

- Uses `/workspace` as the ACP working directory.
- Sends ACP `initialize` before reporting ACP readiness.
- Creates or resumes one canonical ACP session for the Kortix session.
- Pins the canonical ACP session identifier.
- Restarts the child process after an unexpected exit.
- Rejects malformed JSON-RPC envelopes.
- Bounds pending request time, replay events, and diagnostic output.
- Redacts credentials from child-process diagnostics.
- Stops the complete process group during shutdown or restart.

The sandbox agent does not run `opencode serve` beside `opencode acp`.
OpenCode starts its internal HTTP server as part of `opencode acp`.

## Browser-safe transport

The sandbox agent exposes an authenticated bridge through the existing runtime
proxy.

The bridge provides:

- `POST /kortix/acp/:serverId` for one JSON-RPC request or notification.
- `GET /kortix/acp/:serverId` for ordered SSE notifications and responses.
- `DELETE /kortix/acp/:serverId` for bounded runtime disposal.
- `Last-Event-ID` replay with a fixed upper bound.
- SSE keepalive comments.
- One process per Kortix session.

The existing runtime proxy authentication protects these routes.
The browser never receives sandbox credentials or direct process access.

## SDK contract

The SDK owns ACP JSON-RPC, SSE, replay, and session projection.

`useSession(projectId, sessionId)` keeps its current public return type.
Existing OpenCode-named public exports remain available.
This change adds no breaking SDK export rename or removal.

The SDK maps ACP updates into the existing session presentation model:

- User and assistant message chunks.
- Agent thought chunks.
- Tool calls and tool-call updates.
- Plans and tasks.
- Permission requests and responses.
- Available commands.
- Current mode.
- Session metadata.
- Usage and stop reason.
- Errors and cancellation.

The frontend does not import an ACP package.
The frontend does not construct ACP paths.

## Rollback

The server selects the runtime transport.

The default client value is `rest` until ACP parity passes.
A project experimental flag selects `acp`.
Disabling the flag restores `rest`.

The rollback switch must not require a frontend deployment.
The REST path remains covered until ACP dev verification passes.

## Compatibility

ACP must preserve these existing contracts:

1. Start and resume a session.
2. Load the canonical transcript.
3. Stream assistant, thought, tool, plan, and task updates.
4. Send text and supported attachments.
5. Cancel a busy prompt.
6. Answer permission requests.
7. Answer question requests.
8. Run supported slash commands.
9. Select the configured OpenCode agent, mode, and model.
10. Queue a message while a prompt is active.
11. Recover after an SSE disconnect.
12. Recover after an OpenCode ACP process restart.
13. Keep files, PTY, preview, and presentation routes unchanged.
14. Prevent cross-session event or transcript leakage.

OpenCode ACP does not support `/undo` or `/redo`.
The SDK must return an explicit unsupported-command error for those commands.

## Non-goals

- Add Claude ACP.
- Add Codex ACP.
- Add Pi ACP.
- Add multi-agent orchestration.
- Add a harness registry.
- Add a second chat interface.
- Change the session page design.
- Remove OpenCode REST in the same pull request.
- Rename OpenCode-named database fields.

## Verification

The implementation requires:

- RED tests before each SDK implementation slice.
- Sandbox process and bridge tests.
- API proxy and authorization tests.
- SDK reducer, replay, reconnect, and action tests.
- SDK typecheck, full test suite, and packed-install smoke.
- Full web tests and frontend boundary enforcement.
- A real local cloud-sandbox browser session over ACP.
- Network proof that the browser uses `/kortix/acp/`.
- Negative proof that the same session does not use OpenCode prompt REST paths.
- Explicit REST rollback proof.
- PR merge, Deploy Dev completion, deployed SHA proof, and dev browser proof.

## Completion condition

The first ACP step is complete only when OpenCode feature parity passes over ACP
locally and on dev.

The REST rollback path must also pass its focused smoke test.
