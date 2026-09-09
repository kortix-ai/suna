# Custom Pi agents

This contract applies to the `pi-worker` preview. It is not a production release.
Pi runs in the worker sandbox. The environment sandbox runs the execution daemon,
files, and processes. This design uses no Durable Objects.

The session lifecycle starts and stops the worker. Passive proxy retries and SSE
reconnects, including background `POST /log` writes, cannot start it or change
its lifecycle state. Explicit session start
remains available after a stop.

For a Pi session, the environment disables OpenCode startup and runs no Pi
worker. Custom tools call the execution RPC. YAML v3 selects Pi; YAML v2 selects
OpenCode. Existing Pi environments receive the same execution-only daemon upgrade.

YAML v3 requires no `pi_worker` feature flag. It selects Pi during session
creation and push-time compilation, and its worker can download the exact
compiled artifact with its existing session credential. The legacy flag only
requests OpenCode prebuilds for YAML v2 projects when platform prebuilds are off.

## Configuration ownership

| Location | Purpose |
| --- | --- |
| `kortix.yaml` | Runtime, agent names, grants, environment templates, and deployment configuration |
| `.kortix/pi/agents/<name>.md` | Prompt and declarative behavior for one agent |
| `.kortix/pi/agents/<name>.ts` | Optional custom JavaScript behavior, native Pi hooks, and tools |
| `.kortix/pi/skills/<name>/SKILL.md` | Skills compiled into the worker, subject to the agent's skill grant |
| `.kortix/pi/commands/*.md` | Compiled slash commands |
| `.kortix/pi/package.json` and `package-lock.json` | Optional locked dependencies for custom source |

Declare new agents and their platform grants on the project's configured default
branch before creating sessions. A session's `base_ref` selects its source version;
it does not authorize an agent absent from that project declaration.

The manifest agent name joins the Markdown file and source module. One artifact
contains one selected agent. The compiler pins source, behavior, and dependencies
to the same Git SHA. Changing files in a running environment does not change that
worker. Commit the changes and create a session from the new commit.

```yaml
kortix_version: 3
runtime: pi
default_agent: reviewer
pi:
  config_dir: .kortix/pi
agents:
  reviewer:
    connectors: none
    secrets: none
    skills: none
  operator:
    connectors: none
    secrets: none
    skills: none
```

`agents.<name>` accepts the existing governance fields: `enabled`, `sandbox`,
`connectors`, `connectors_required`, `connectors_personal` (legacy alias), `secrets`,
`skills`, `kortix_cli`, and `workspace`. Behavior belongs in the Markdown or source.
The `sandbox` field selects the execution environment template. The platform owns
the worker image and identity.

Version 3 selects Pi and defaults to `.kortix/pi`. Version 2 selects OpenCode
and defaults to `.kortix/opencode`. Contradictory runtime declarations fail validation. `opencode.config_dir` remains a compatibility
alias. Setting both directories to different values fails compilation. Directories
must be relative to the repository. Other fields in the `pi` or `opencode` block
are rejected by the Pi compiler.

## Agent Markdown

For `.kortix/pi/agents/reviewer.md`:

```markdown
---
description: Review supplied text
model: gpt-5.6-luna
temperature: 0.2
steps: 4
permission:
  '*': deny
  review_text: allow
---
Use review_text when asked to count words. Explain the result briefly.
```

| Field | Effect |
| --- | --- |
| Markdown body | System prompt |
| `model` | Initial model; an explicit session model selection takes precedence |
| `temperature`, `top_p` | Provider sampling settings, subject to model support |
| `variant` | Default reasoning effort; validated against the selected model |
| `steps` | Native turn limit; a final response follows the permitted tool steps |
| `permission` | Tool allow, ask, or deny policy; custom tool names use the same policy |
| `description`, `mode`, `color`, `hidden` | Agent metadata exposed through the compatibility API |
| `disable` | Disables this agent; manifest `enabled: false` also disables it |

For file tools, permission patterns inside the workspace are relative to the workspace root. For example, `read: { "images/**": allow }` permits files under `/workspace/images`. External paths use absolute patterns.

Unknown fields fail compilation. Nonempty `options` is unsupported.
Empty legacy `variant: ''` and `options: {}` are tolerated. OpenCode plugins, MCP
configuration, Pi CLI settings files, and coding-agent TUI extensions are not
loaded through these fields.

Missing, invalid, disabled, or undeclared selected-agent configuration fails
compilation or session admission. It does not silently substitute another agent.
A source module is optional. Existing Markdown-only agents keep working.

`variant` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Each model supports a subset. Unsupported choices fail before model execution.
For gateway aliases, the compiled model metadata carries the catalog's effort
levels. An unknown alias cannot inherit another model's reasoning capabilities.
The Markdown default takes precedence over a source module's `thinkingLevel`.
An explicit HTTP prompt or SDK `send` variant applies only to that prompt.
The worker stores this choice before acknowledgment and restores the default
after the prompt. Question recovery preserves the stored choice.
Commands accept a supported request variant. Otherwise, they use the compiled
command variant, then the agent default. SDK prompt and command paths preserve
this choice. The React composer reads supported levels from the pinned worker's
config. Its Thinking effort control persists a choice for this session and model.
Auto clears that override, so commands and prompts use their compiled defaults.
Workers without this capability projection keep the control hidden.

## Custom source

Use exactly one of `<name>.ts`, `<name>.js`, or `<name>.mjs` beside its Markdown.
Export a factory with `definePiAgent` from `@kortix/sdk/pi`. The factory receives
`agentName`, `sessionId`, `sourceSha`, `env`, and a callback-scoped `signal`.

```ts
import { definePiAgent } from '@kortix/sdk/pi';
import { Type } from 'typebox';

export default definePiAgent(({ env, sessionId }) => ({
  tools: [{
    name: 'write_note',
    label: 'Write note',
    description: 'Write and read back a note in the execution environment.',
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      const { text } = params as { text: string };
      const path = `/workspace/note-${sessionId}.txt`;
      const written = await env.writeFile(path, text);
      if (!written.ok) throw written.error;
      const read = await env.readTextFile(path);
      if (!read.ok) throw read.error;
      return {
        content: [{ type: 'text', text: read.value }],
        details: { path },
      };
    },
  }],
}));
```

`env` is native Pi `ExecutionEnv` backed by Kortix RPC. Use it for files and
commands. The first operation requests the environment. Pure JavaScript tools
leave the environment off. An initialization hook that uses `env` requests it at
startup. Direct Node filesystem and process APIs target the restricted worker;
they do not provide workspace access.

Custom source is trusted project code. It runs with the worker's agent identity.
Session tool approvals guard model-requested tools. They are not an isolation
boundary against the project's own lifecycle code. Platform grants still apply
to API calls. Do not grant source-editing access to an untrusted collaborator.

The checked examples are [reviewer](../packages/sdk/examples/12-pi-reviewer.ts) and
[operator](../packages/sdk/examples/13-pi-operator.ts). Copy each default export
into the matching project agent source. Replace the examples' relative SDK import
with `@kortix/sdk/pi`. Both examples use native JSON tool schemas.

## Native hooks and lifecycle

The definition uses Pi Agent Core 0.84.3 hook signatures. Kortix owns session
transport, model routing, persistence, approvals, and remote execution.

| Hook or setting | Contract |
| --- | --- |
| `initialize(context)` | Once per worker process, before accepting HTTP traffic |
| `transformContext(messages, signal)` | Native transformation before a model request |
| `beforeToolCall(context, signal)` | Native tool precheck; may block the call |
| `afterToolCall(context, signal)` | Native tool-result transformation |
| `shouldStopAfterTurn(context, signal)` | Native continuation decision; platform step limits still apply |
| `onPayload`, `onResponse` | Native provider request and response hooks |
| `onEvent(event, signal)` | Native agent, turn, message, and tool events; receives a copy |
| `cancel(context)` | Once when an aborted run reaches `agent_end` |
| `shutdown(context)` | Once on graceful close; aborts active work and waits for idle first |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; model support applies |
| `hookTimeoutMs` | Integer from 1 to 30000; default 5000 |

Unknown definition fields and malformed hooks fail worker startup. Duplicate
custom tool names and attempts to replace platform tools fail startup. Tools use
native Pi schemas and results. Their execution uses the turn's cancellation
signal, without the short lifecycle-hook deadline.

Factory evaluation has a 5000 ms deadline. Lifecycle and native hooks use
`hookTimeoutMs`. Deadlines settle asynchronous callbacks and abort their remote
operations. They cannot preempt synchronous JavaScript that blocks the event loop.
Avoid blocking loops. Worker isolation and process termination remain necessary.

## Failure and recovery

- Factory or initialization failure prevents readiness. The worker reports a fatal
  startup error. Fix the source and create a session from the corrected commit.
- A turn hook failure becomes a terminal error for that run. The next prompt can
  run again. Event-hook failure disables further custom event callbacks for that
  run. The next `agent_start` resets that guard.
- Stop aborts active tools and hooks. `cancel` receives a separate bounded cleanup
  scope. The terminal `agent_end` observer receives the aborted native signal.
- Finished, timed-out, or aborted callbacks cannot start detached `env` operations.
  A cancellation request cannot undo an external effect that already completed.
- A failed shutdown hook is reported. The HTTP server still closes. The executable
  exits with status 1. Successful graceful shutdown exits with status 0.
- SIGKILL, provider suspension, and VM loss do not guarantee a shutdown callback.
  Cleanup hooks must not be the only place that saves important state.
- History and permission decisions persist outside the worker in PostgreSQL.
  JavaScript variables, timers, and factory state do not survive replacement.
  Replacement runs initialization again and restores the conversation.
- Recovery of pending approvals can replay turn and pre-tool hooks. Make hook
  side effects idempotent. The platform's tool-release checkpoint does not make
  arbitrary custom callbacks exactly-once.

## Dependencies and compilation

Relative imports stay inside the configured source directory. The compiler bundles
reachable source into the `.mjs` artifact without executing project code. It
supports TypeScript, JavaScript, JSON, and imported Markdown/text. It rejects
compile-time macros and unresolved imports. It does not perform TypeScript type
checking; run `tsc --noEmit` in the authoring project.

The compiler supplies `@kortix/sdk/pi`, Pi Agent Core 0.84.3, Pi AI 0.84.3, and
TypeBox 1.3.7. Other packages require `package.json` plus npm lockfile version 3:

```sh
cd .kortix/pi
npm install --package-lock-only --ignore-scripts --save-exact is-number@7.0.0
```

Commit both files. The compiler downloads public `registry.npmjs.org` archives,
verifies SHA-512 integrity, and bundles their JavaScript. It never runs install
scripts. Private registries, Git dependencies, links, native addons, install-time
builds, and runtime asset loading are unsupported. Use static imports. A dynamic
import that cannot be bundled is not a supported dependency-loading mechanism.

Limits: 256 source files, 8 MiB total source; 128 locked production packages;
8 MiB per compressed archive, 64 MiB total downloads; 128 MiB total unpacked data;
20000 archive entries; 90 seconds for dependency downloads. The artifact manifest
records the custom module hash and dependency lock hash.

## Session permission controls

“Allow everything” saves session overrides before releasing the pending tool.
It survives reload, a new browser, and worker replacement. A failed update keeps
the pending prompt available for retry and does not release the tool. “Turn off”
removes the session override and restores compiled agent permissions. A failed
reset keeps the saved grant visible until retry succeeds.

These controls do not alter the Git configuration or another session.


## Native tool images

Custom tools can return native Pi image blocks alongside text:

```ts
return {
  content: [
    { type: 'text', text: 'Capture complete.' },
    { type: 'image', mimeType: 'image/png', data: pngBase64 },
  ],
  details: { source: 'capture' },
};
```

The worker saves PNG, JPEG, GIF, and WebP bytes in session-scoped PostgreSQL
storage before it records the tool result. Each result accepts up to 16 images,
8 MiB per image, and 16 MiB total. Invalid base64, unsupported MIME types, and
storage failures produce a tool error. Stop cancels a pending upload.

The durable journal and SSE transcript contain immutable references. Provider
requests and native custom hooks receive hydrated image bytes. Tool metadata,
text, and `afterToolCall` overrides retain their native behavior. Replayed tool
results reuse saved assets without executing the tool again.

The conversation displays completed tool images using authenticated thumbnails
and the existing image viewer. Reload and worker replacement preserve the asset
URLs and exact bytes. Images produced in the worker do not start an environment.
The native `read` tool reads workspace images through the execution environment.

## Provider context overflow

When an ordinary provider request rejects an existing conversation for context
overflow, Pi can summarize and retry once per prompt. Recovery preserves completed
tool results. It does not repeat the prompt or an executed tool. Custom context
transforms and native image hydration also run for the replacement request.
Stop cancels recovery. A visible partial response, repeated overflow, unrelated
provider error, or oversized first input retains an error instead of retrying.

## Connector and remote MCP tools

Pi exposes `connector_search`, `connector_describe`, and `connector_call` when
the worker has its project identity and API credential. Registration performs no
network discovery. Calls use the SDK and the existing Kortix connector gateway.
They do not start the execution environment.

Declare remote MCP servers through the existing project connector configuration:

```yaml
kortix_version: 3
default_agent: reviewer
connectors:
  - slug: research
    provider: mcp
    url: https://example.com/mcp
    transport: http
    auth:
      type: none
agents:
  reviewer:
    connectors: [research]
    secrets: none
```

Replace the example URL with the actual server. Configure credentials through
Kortix Connections or project secrets. Do not commit credentials in YAML.
The connector gateway owns discovery, MCP protocol negotiation, credentials,
agent grants, and action policy. The worker receives only authorized tools.

Use `connector_search` to find `connector.action` identifiers. Use
`connector_describe` to inspect the input schema before `connector_call`.
Per-agent permission patterns match that identifier. For example,
`connector_call: { "research.*": ask }` requests the existing permission UI.
Custom Pi modules cannot replace these three platform tools.

MCP text, text resources, resource links, structured output, and native images
reach the model. Embedded PNG, JPEG, GIF, and WebP resources also become native
images. Their URI remains text metadata; their base64 bytes use the private
attachment pipeline. Unsupported binary content fails explicitly. Text results are bounded to 512 KiB.
A JSON-RPC error or MCP `isError` result fails the tool even when HTTP succeeds.

A connector policy approval returns the existing approval link. The agent shows
that link and waits. The worker does not poll or automatically resubmit a write.
Stop cancels its HTTP request and permits the next prompt. Cancellation cannot
undo an action that the remote service already accepted.

This adapter supports remote MCP through project connectors. It does not load
OpenCode `mcp` configuration, Pi CLI settings, stdio servers, MCP prompts, or
resource subscriptions. Those remain separate parity work.
