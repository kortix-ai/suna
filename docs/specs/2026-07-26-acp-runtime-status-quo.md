# ACP runtime status quo and handoff

> **Superseded on 2026-07-28.** This document preserves the OpenCode-only
> status before ACP multi-harness support. PR #5762 added runtime profiles and
> OpenCode, Claude Code, Codex, and Pi harness selection. Use
> `docs/superpowers/specs/2026-07-28-acp-multi-harness-design.md` and the current
> `kortix-system` runtime-harness reference for the active contract.

**Date:** 2026-07-26

**Status:** Current implementation and operational reference

**Scope:** OpenCode ACP, the REST compatibility transport, `@kortix/sdk`,
`apps/web`, and `apps/whitelabel-demo`

The earlier
[OpenCode ACP canary](../superpowers/specs/2026-07-25-opencode-acp-canary-design.md)
is the historical design. This document records the implemented state after
PR #5477.

## 1. Executive status

The platform starts OpenCode in ACP mode for every normal project session.

The project experiment does not control the OpenCode process. It controls the
SDK client transport.

The exact invariant is:

> Every normal sandbox starts one `opencode acp` process. The API selects either
> ACP or REST compatibility for the SDK client. Both transports reach the same
> OpenCode process.

The normal flow does not start `opencode serve` beside `opencode acp`.
OpenCode ACP starts its own internal HTTP server on the configured port.
The REST compatibility client uses that internal server.

The current implementation supports one runtime harness: OpenCode.
The architecture does not yet provide a harness registry.

## 2. Terminology

Use these terms consistently.

### OpenCode process transport

The OpenCode process transport selects the daemon launch command.

- `acp` starts `opencode acp`.
- `rest` starts `opencode serve`.

`KORTIX_OPENCODE_PROCESS_TRANSPORT` carries this value into the sandbox.
Normal API session creation always sets this value to `acp`.

The `rest` process value remains a low-level recovery path. It is not the
normal project experiment path.

### SDK client transport

The SDK client transport selects how `useSession()` handles chat state.

- `acp` uses the authenticated ACP HTTP/SSE bridge.
- `rest` uses the OpenCode REST compatibility interface.

`POST /projects/:projectId/sessions/:sessionId/start` returns the selected value
as `runtime_transport`.

### Project experiment

`acp_runtime` is a server-owned project experiment.

- Enabled selects the ACP SDK client transport.
- Disabled selects the REST compatibility SDK client transport.

The experiment does not start or stop ACP.
The frontend does not hard-code the experiment key.
The API returns the experimental feature catalog and its selected state.

`KORTIX_OPENCODE_TRANSPORT=acp` is an operator-wide client transport override.
The project setting otherwise controls the selection.

## 3. End-to-end boot sequence

The current boot and client flow is:

```text
project session start
  -> apps/api builds session runtime environment
  -> KORTIX_OPENCODE_PROCESS_TRANSPORT=acp
  -> sandbox agent starts
  -> sandbox agent starts `opencode acp`
  -> daemon sends ACP `initialize`
  -> daemon creates or resumes the canonical OpenCode session
  -> daemon pins and reports the canonical session identifier
  -> API returns `runtime_transport`
  -> SDK `useSession()` consumes that server value
      -> ACP: HTTP/SSE bridge and ACP projection
      -> REST: internal OpenCode HTTP compatibility interface
  -> one unchanged frontend session workbench
```

The detailed sequence is:

1. The API resolves the project, session, sandbox, model, agent, and compiled
   agent configuration.
2. `buildSessionRuntimeEnv()` writes
   `KORTIX_OPENCODE_PROCESS_TRANSPORT=acp`.
3. The provider creates or resumes the session sandbox.
4. The sandbox starts `kortix-sandbox-agent-server`.
5. The daemon resolves the OpenCode executable.
6. The daemon starts:

   ```text
   opencode acp --port <internal-port> --hostname 127.0.0.1 --cwd <workspace>
   ```

7. The daemon connects to the child process through JSON-RPC on standard input
   and standard output.
8. The daemon sends ACP `initialize` with protocol version `1`.
9. The daemon resumes the pinned canonical session when one exists.
10. Otherwise, the daemon creates the canonical session with `session/new`.
11. The daemon pins the canonical session in the sandbox.
12. The daemon reports the pin to the API.
13. The daemon publishes `kortix/runtime_ready` after ACP initialization.
14. The API `/start` response includes the canonical
    `opencode_session_id` and selected `runtime_transport`.
15. `useSession(projectId, sessionId)` polls `/start` until the runtime is ready.
16. The SDK binds its runtime to the returned sandbox.
17. The SDK opens the selected chat transport.

## 4. Always-on ACP process behavior

Normal API session creation sets `opencodeProcessTransport: 'acp'` in
`apps/api/src/projects/lib/sessions.ts`.

`apps/api/src/projects/lib/session-runtime-env.ts` serializes that value as
`KORTIX_OPENCODE_PROCESS_TRANSPORT`.

`apps/kortix-sandbox-agent-server/src/acp/connection.ts` builds the actual
OpenCode command. ACP mode also sets:

```text
OPENCODE_ENABLE_QUESTION_TOOL=1
```

This environment variable keeps OpenCode's interactive question tool available
for the non-TUI ACP client.

The daemon sends signals to the complete OpenCode process group during stop or
restart. An unexpected child exit triggers an automatic restart with bounded
backoff.

The daemon preserves the ACP SSE event cursor across OpenCode restarts. It
publishes `kortix/runtime_ready` after the replacement process initializes.

## 5. REST compatibility behavior

REST compatibility is a client path. It is not a second OpenCode process.

OpenCode's `acp` command exposes its internal HTTP server on the same configured
port. The REST compatibility SDK path uses that server for:

- `/global/event`
- Session listing
- Message synchronization
- `prompt_async`
- REST command, cancellation, question, and permission operations

This path exists for rollback and parity comparison.
It remains covered by the deployed browser matrix.

The daemon still accepts `KORTIX_OPENCODE_PROCESS_TRANSPORT=rest`.
That value starts `opencode serve`.
Normal API session creation does not emit this value.

## 6. API-owned client transport selection

`resolveProjectRuntimeTransport()` owns the selection.

The order is:

1. `KORTIX_OPENCODE_TRANSPORT=acp` selects ACP globally.
2. Otherwise, an enabled `acp_runtime` project experiment selects ACP.
3. Otherwise, the API returns `rest`.

The session start route serializes this result as:

```json
{
  "runtime_transport": "acp"
}
```

or:

```json
{
  "runtime_transport": "rest"
}
```

The frontend does not read an environment variable to select a transport.
The frontend does not calculate the selection from project metadata.
The SDK consumes the API result.

## 7. SDK ownership and `useSession()`

`@kortix/sdk` is the source of truth for both transports.

`createSessionRuntimePolicy()` converts `runtime_transport` into one internal
policy.

For ACP, the policy:

- Enables the ACP controller.
- Disables the OpenCode REST event stream.
- Disables OpenCode REST session listing.
- Disables OpenCode REST message synchronization.
- Sends prompts through ACP.

For REST compatibility, the policy:

- Disables the ACP controller.
- Enables the OpenCode REST event stream.
- Enables OpenCode REST session listing.
- Enables OpenCode REST message synchronization.
- Sends prompts through OpenCode REST.

`useSession(projectId, sessionId)` owns:

- Session start polling
- Sandbox runtime binding
- Runtime health state
- Canonical session resolution
- ACP or REST transcript synchronization
- Prompt send and cancellation
- Commands
- Model and agent selection
- Questions
- Permissions
- Pending message state
- Busy and idle state
- Restart recovery

Hosts receive one return shape.
Hosts do not mount a second event provider.
Hosts do not create a transport client.
Hosts do not construct an ACP endpoint.

## 8. Frontend and white-label boundaries

`apps/web` and `apps/whitelabel-demo` use the SDK as their backend boundary.

The white-label app creates one browser client in
`apps/whitelabel-demo/src/lib/kortix.ts`.
The session page calls one `useSession(projectId, sessionId)` hook.

The project settings page renders the server-provided experimental feature
catalog. It calls `updateExperimentalFeature(feature.key, enabled)`.
It does not contain the `acp_runtime` key.

The white-label SDK boundary rejects:

- `@opencode-ai/sdk` imports
- Direct SDK runtime subpath imports
- Runtime proxy URL construction
- OpenCode REST paths
- Legacy runtime stores
- Provider-specific client terminology
- Raw Kortix requests
- Application tests that bypass the public SDK

The `apps/web` boundary rejects:

- Import paths or imported names containing `opencode`
- `@opencode-ai/sdk`
- Deprecated SDK runtime subpaths
- Host-local runtime modules and stores
- Host-local Kortix API clients
- Direct runtime identifiers
- Runtime proxy paths
- Restricted raw Kortix network paths

`apps/web/src/sdk-boundary-baseline.json` contains zero entries.
New production violations fail the boundary test.

ESLint also rejects the forbidden imports in `apps/web`.
CI runs the boundary test and ESLint before the frontend build.

The SDK itself still contains OpenCode compatibility code and types.
The frontend import ban does not apply inside `packages/sdk`.

## 9. ACP HTTP/SSE bridge and authentication

The browser-safe bridge is:

```text
POST /v1/p/<external_id>/8000/kortix/acp/<canonical_session_id>
GET  /v1/p/<external_id>/8000/kortix/acp/<canonical_session_id>
```

The SDK constructs this path internally.

`POST` accepts one JSON-RPC request, notification, or client response.
It returns `202` after the daemon writes the envelope to OpenCode.
The corresponding JSON-RPC response arrives through SSE.

`GET` opens the ordered SSE stream.
The stream supports `Last-Event-ID`.
The daemon keeps up to 2,000 replay events by default.
The daemon sends a keepalive comment every 15 seconds.

The bridge allows these session methods:

- `session/load`
- `session/resume`
- `session/prompt`
- `session/cancel`
- `session/set_config_option`

The bridge rejects:

- An unknown canonical session identifier with `404`
- A payload session mismatch with `409`
- A disallowed ACP method with `405`
- A malformed JSON-RPC envelope with `400`
- A request before ACP readiness with `503`

Authentication has two layers.

1. The SDK sends the user's normal Kortix bearer token to the API proxy.
2. The API validates sandbox ownership and signs `X-Kortix-User-Context`.
3. The sandbox daemon validates that signed context with the sandbox token.

The browser does not receive the sandbox token.
The browser does not connect directly to OpenCode standard input or output.

The SDK exempts ACP SSE URLs from the default 30-second request timeout.
The ACP client reconnects with exponential backoff up to 5 seconds.
It resumes from the last processed event identifier.

## 10. Canonical session identity and restart recovery

The canonical runtime session is still stored as `opencode_session_id`.
This name is a compatibility field.

The daemon follows these rules:

1. Reuse a pinned canonical root when it exists.
2. Otherwise, reuse the most recently active valid root.
3. Create a new root only when no valid root exists.
4. Rotate a warm fork away from the snapshot seed root.
5. Abort an interrupted turn before resuming a reused root.
6. Deliver the initial prompt only when the root has no prior messages.
7. Persist the root pin in the sandbox.
8. Report the root pin to the API.

These rules prevent duplicate initial prompts after daemon or OpenCode restarts.
They also prevent multiple warm forks from sharing one conversation.

When OpenCode restarts:

- The daemon initializes the new ACP process.
- The daemon resumes the canonical session.
- The daemon emits `kortix/runtime_ready`.
- The SDK resets its ACP projection.
- The SDK reloads the canonical transcript with `session/load`.

If the restart happens before prompt dispatch, the SDK retries configuration
preparation up to three times.

If the restart happens after prompt dispatch, the SDK does not resend the
prompt. It returns an explicit ambiguous-result error. This rule prevents
duplicate side effects.

## 11. Questions and permissions

### Permissions

OpenCode sends ACP `session/request_permission`.
The SDK projects it into the existing permission UI shape.

The SDK maps UI replies to ACP option kinds:

- `once` selects `allow_once` or `allow`.
- `always` selects `allow_always` or `always`.
- `reject` selects a reject option or returns a cancelled outcome.

The selected response goes back through ACP JSON-RPC.

### Questions

OpenCode's question tool is not a native OpenCode ACP request.
The daemon provides a compatibility bridge.

The flow is:

1. OpenCode emits `question.asked` on its internal event stream.
2. The daemon converts the event into ACP `session/request_input`.
3. The SDK projects the request into the existing question UI shape.
4. The user accepts or declines the question in the frontend.
5. The SDK sends one ACP JSON-RPC response.
6. The daemon converts that response into OpenCode's internal
   `/question/:id/reply` or `/question/:id/reject` request.
7. OpenCode resumes the blocked tool call.

Question requests have no daemon timeout.
Unresolved requests remain pending.
New SSE subscribers receive unresolved requests again.
Duplicate client responses are ignored after the first completed response.

The browser never calls OpenCode's question REST API.

## 12. Prompt settlement and late updates

OpenCode can return an ACP prompt result before all late tool or message updates
reach the browser.

The ACP controller prevents a false idle state:

- The prompt result keeps the projection busy.
- A 500-millisecond quiet period starts after the result.
- A late `session/update` restarts the quiet period.
- Running tools, questions, and permissions block settlement.
- The controller marks the transcript idle only after the quiet period has no
  blockers.
- The prompt queue waits for settlement before it dispatches the next prompt.

REST compatibility has an equivalent monotonic busy rule.

- An accepted REST prompt starts an `awaiting-work` observation.
- A stale idle event cannot clear the busy state.
- Assistant output or a non-idle runtime state proves that work started.
- A following idle state must remain quiet for 500 milliseconds.
- Late activity cancels the settlement timer.

This behavior prevents screenshots and consumers from observing a completed
turn before its late tool cards arrive.

## 13. Files, previews, PTY, and non-chat surfaces

The chat transport does not control non-chat surfaces.

These surfaces remain SDK-owned and transport-independent:

- Project and session files
- File search and history
- File archives
- Preview discovery
- Preview URL resolution
- Public preview shares
- Git and change requests
- Session health
- Presentation conversion
- Kortix-native PTY

The Kortix PTY uses `/kortix/pty`.
It does not use OpenCode's PTY interface.
It remains available when the OpenCode chat process is unavailable.

The white-label preview UI uses a same-origin application route.
That server route creates a request-scoped SDK client, checks ownership,
ensures session readiness, resolves the preview through the SDK, and returns
one final URL.

The client does not construct sandbox coordinates or preview proxy URLs.

## 14. Enforcement and CI gates

### White-label app

These scripts run the boundary scanner first:

```text
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test
```

`package-tests.yml` includes the white-label app test suite.

### Main web app

The frontend CI job runs:

```text
pnpm --dir apps/web exec bun test src/sdk-boundary.test.ts
pnpm --dir apps/web exec eslint src --quiet
pnpm --filter ./apps/web build
```

The boundary test compares the current scan against a checked-in baseline.
The baseline currently contains zero violations.

### SDK

SDK changes require:

- Failing tests before implementation
- SDK typecheck
- Full SDK tests
- Bundle build
- Packed-install smoke
- Public export and type-surface checks
- Framework-free core import-graph enforcement

The SDK is a published package.
Public compatibility names cannot be removed without a breaking migration.

## 15. Rollback procedures

### Per-project client rollback

Disable the server-provided ACP Runtime experiment for the project.

The next `/start` response returns:

```json
{
  "runtime_transport": "rest"
}
```

The frontend deployment does not change.
The sandbox still runs `opencode acp`.
The SDK reconnects through REST compatibility.

### Operator-wide ACP client rollout

Set:

```text
KORTIX_OPENCODE_TRANSPORT=acp
```

This override selects ACP for every project while the feature remains
available.

Remove the override to restore project-specific selection.

### Operator-wide emergency client rollback

The current configuration has no `rest` operator override.
Remove the ACP override and disable `acp_runtime` on affected projects.

### Low-level process rollback

Set:

```text
KORTIX_OPENCODE_PROCESS_TRANSPORT=rest
```

This starts `opencode serve`.
Normal API session creation overwrites this value with `acp`.
Use this path only for direct daemon diagnostics or a code-level emergency
rollback.

## 16. Current limitations and retained compatibility

The following work remains:

1. OpenCode ACP does not support `/undo`.
   The SDK returns `OpenCode ACP does not support /undo`.
2. OpenCode ACP does not support `/redo`.
   The SDK returns `OpenCode ACP does not support /redo`.
3. The SDK public surface still contains OpenCode-specific names.
4. `project_sessions.opencode_session_id` remains the durable canonical pin.
5. The API still returns `opencode_session_id`.
6. `useSession()` still returns `opencodeSessionId`.
7. `packages/sdk` still depends on `@opencode-ai/sdk` for REST compatibility
   types and clients.
8. The REST compatibility transport remains implemented and supported.
9. The sandbox daemon still contains a low-level `opencode serve` launch path.
10. The ACP bridge is OpenCode-backed. It is not a generic harness adapter.
11. The current ACP projection maps into existing OpenCode-compatible message
    and part types.
12. No Pi, Claude, Codex, or other runtime harness is integrated through this
    path.

These limitations do not permit frontend provider imports.
All compatibility remains inside the API, daemon, and SDK.

## 17. Verified delivery evidence

The stable ACP and REST completion work shipped through:

- PR: `#5477`
- Merge SHA: `480a44dcb9c6fce4f1f51c54dcb017750d187bdb`
- Deploy Dev run: `30184932143`
- API version: `0.10.16-dev.480a44dc`
- API image: `dev-480a44dc`
- Vercel deployment: `dpl_FX4EmhvavKet4MvwcDyjVeqxZWdD`
- Vercel alias: `dev.kortix.com`

The final deployed ACP and REST parity run produced:

- Playwright: `1 passed` in `13.8m`
- ACP prompts: `2`
- ACP REST prompts: `0`
- REST ACP prompts: `0`
- REST prompts: `2`
- ACP completed tool cards: `28`
- REST completed tool cards: `24`
- ACP presentation:
  `/workspace/marko-kraemer.pptx`, `250,193` bytes
- REST presentation:
  `/workspace/marko-kraemer.pptx`, `237,913` bytes
- Both transports completed the question flow.
- Both transports rendered `QUESTION_BETA`.
- Cleanup: `active_projects=0`
- Cleanup: `cleanup_users=0`

Git ancestry from the current base includes the merge SHA.
The source evidence for these values is the completed B23 entry in
`packages/sdk/PROGRESS.md`.

## 18. Future ACP-only migration path

Complete the migration in separate, reversible steps.

### Step 1: Introduce runtime-neutral SDK types

Add Kortix-owned message, part, session, permission, and question types.
Keep the current exported types as compatibility aliases.
Do not remove public exports in a minor release.

### Step 2: Rename the canonical pin

Add a runtime-neutral database field such as `runtime_session_id`.
Backfill it from `opencode_session_id`.
Write both fields during the compatibility period.
Change API responses to add the neutral field.
Change the SDK to prefer the neutral field.
Remove the old field only through a versioned migration.

### Step 3: Make ACP the default SDK client transport

Change the API default after production ACP parity passes.
Retain the per-project REST rollback during the soak period.
Continue the dual-transport browser matrix.

### Step 4: Remove OpenCode REST compatibility

Remove REST only after:

- ACP is the default in production.
- Error rate and completion rate meet the agreed threshold.
- Questions and permissions pass sustained production use.
- Restart recovery passes sustained production use.
- No supported client depends on REST-only behavior.

Then remove:

- REST session event and message synchronization
- REST prompt dispatch
- REST-specific SDK stores and hooks
- `@opencode-ai/sdk` client dependency
- The project REST rollback
- The low-level `opencode serve` launch path, if operations no longer need it

### Step 5: Add a runtime adapter contract

Define one server-side adapter contract for:

- Process launch and readiness
- Session create, load, resume, and cancel
- Prompt dispatch
- ACP event transport
- Questions and permissions
- Model, mode, and command capabilities
- Restart and canonical session recovery

Implement OpenCode first.
Add Pi or another harness as a second implementation.
Do not add harness-specific branches to frontend code.

## 19. Key source-file index

### API

- `apps/api/src/projects/lib/sessions.ts`
  always selects the ACP OpenCode process.
- `apps/api/src/projects/lib/session-runtime-env.ts`
  serializes the sandbox process transport.
- `apps/api/src/experimental/features.ts`
  defines `acp_runtime` and selects the SDK client transport.
- `apps/api/src/projects/routes/r8.ts`
  returns `runtime_transport` from `/start`.
- `apps/api/src/projects/opencode-mapping.ts`
  owns canonical OpenCode session pin resolution.
- `apps/api/src/sandbox-proxy/backend.ts`
  signs the sandbox user context.

### Sandbox daemon

- `apps/kortix-sandbox-agent-server/src/acp/connection.ts`
  launches OpenCode and owns JSON-RPC plus SSE replay.
- `apps/kortix-sandbox-agent-server/src/acp/questions.ts`
  bridges OpenCode questions into ACP input requests.
- `apps/kortix-sandbox-agent-server/src/opencode.ts`
  supervises the process and resumes ACP after restart.
- `apps/kortix-sandbox-agent-server/src/main.ts`
  creates, resumes, pins, and reports the canonical session.
- `apps/kortix-sandbox-agent-server/src/routes/acp.ts`
  exposes the authenticated ACP HTTP/SSE bridge.
- `apps/kortix-sandbox-agent-server/src/proxy.ts`
  mounts ACP, files, PTY, preview, and OpenCode compatibility routes.

### SDK

- `packages/sdk/src/core/session/runtime-transport.ts`
  defines the internal transport policy and ACP endpoint builder.
- `packages/sdk/src/core/acp/client.ts`
  implements ACP JSON-RPC over POST and SSE.
- `packages/sdk/src/core/acp/session-controller.ts`
  owns ACP lifecycle, restart recovery, actions, and prompt settlement.
- `packages/sdk/src/core/acp/projection.ts`
  projects ACP events into the session UI model.
- `packages/sdk/src/core/session-sync/session-sync-controller.ts`
  owns REST monotonic prompt settlement.
- `packages/sdk/src/react/use-session.ts`
  owns the complete React session lifecycle.
- `packages/sdk/src/platform/auth-core.ts`
  injects auth and exempts long-lived ACP streams from request timeouts.
- `packages/sdk/src/core/runtime/pty.ts`
  implements the Kortix-native PTY client.

### Frontends

- `apps/whitelabel-demo/src/lib/kortix.ts`
  creates the one white-label browser client.
- `apps/whitelabel-demo/src/app/projects/[id]/sessions/[sessionId]/page.tsx`
  calls the one session hook.
- `apps/whitelabel-demo/scripts/sdk-boundary.mjs`
  enforces the white-label SDK boundary.
- `apps/web/scripts/sdk-boundary.mjs`
  scans the main frontend boundary.
- `apps/web/eslint.config.mjs`
  rejects forbidden imports during lint.
- `apps/web/src/sdk-boundary.test.ts`
  enforces the zero-entry baseline in CI.

## 20. Operational debugging checklist

Use this order.

1. Read the `/start` response.
   Confirm `stage`, `sandbox.external_id`, `opencode_session_id`, and
   `runtime_transport`.
2. Confirm the process environment.
   `KORTIX_OPENCODE_PROCESS_TRANSPORT` must equal `acp`.
3. Read daemon logs.
   Find `[opencode] spawning` with `transport: "acp"`.
4. Confirm ACP initialization.
   Find `[opencode-acp] initialized` with protocol version `1`.
5. Confirm the canonical session.
   Find create or resume logs and the pinned session identifier.
6. Confirm runtime readiness.
   Check `/kortix/health` and the `kortix/runtime_ready` event.
7. Inspect browser network traffic.
   ACP must use `/kortix/acp/<session>`.
8. Check negative transport proof.
   An ACP prompt must not call `/prompt_async`.
9. For REST compatibility, check the inverse.
   A REST prompt must call `/prompt_async` and must not call the ACP bridge.
10. For an ACP stream failure, inspect the HTTP status.
    `401` means signed user-context failure.
    `404` means canonical session mismatch.
    `503` means the ACP process or canonical session is not ready.
11. For a missing transcript after restart, confirm `session/load` follows
    `kortix/runtime_ready`.
12. For a stuck question, confirm all four events:
    `question.asked`, ACP `session/request_input`, the client response, and
    OpenCode `/question/:id/reply` or `/reject`.
13. For a false idle state, inspect late `session/update` events.
    Confirm no running tool, question, or permission remains.
14. For a frontend boundary regression, run both scanners.
15. For a full parity check, run one ACP project and one REST compatibility
    project with the same prompt.
16. Compare prompt paths, assistant output, completed tool cards, question
    completion, generated file size, and final idle state.

The current golden prompt is:

```text
Research Marko Kraemer and create a presentation about them.
```

The white-label reference app is the golden consumer.
The REST compatibility rendering is the comparison baseline during ACP
projection changes.
