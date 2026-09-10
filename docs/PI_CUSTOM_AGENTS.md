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
`skills`, `kortix_cli`, `workspace`, and `resources`. Behavior belongs in the Markdown or source.
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
`agentName`, `sessionId`, `sourceSha`, `env`, durable `state`, bundled `resources`, and a callback-scoped `signal`.

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

## Files required by custom code

Declare files separately from source imports. The compiler reads their bytes from
the same Git commit as the agent code. No environment checkout is needed to read
a worker resource. Only the selected agent's declarations enter its artifact.

```yaml
kortix_version: 3
default_agent: reporter
agents:
  reporter:
    resources:
      worker:
        rules: assets/rules.json
      environment:
        - source: assets/template.txt
          target: /workspace/template.txt
          mode: seed
        - source: scripts/report.py
          target: /opt/kortix/helpers/report.py
          mode: read_only
```

| Declaration | Placement and access |
| --- | --- |
| `worker.rules` | Bytes inside the `.mjs` bundle. Custom code calls `resources.readJson('rules')`. No local pathname is created. |
| `environment`, `mode: seed` | A working file below `/workspace`. Install once in an environment. Preserve existing files, later edits, and intentional deletions on restart. |
| `environment`, `mode: read_only` | A helper below `/opt/kortix/helpers`, installed with mode `0444`. Restore its compiled bytes at environment startup. Run scripts through an interpreter. |

In `.kortix/pi/agents/reporter.ts`:

```ts
import { definePiAgent } from '@kortix/sdk/pi';

export default definePiAgent(async ({ resources, env }) => {
  if (!resources) throw new Error('This agent requires bundled resource support');
  const rules = await resources.readJson('rules');
  return {
    tools: [{
      name: 'make_report', label: 'Make report', description: 'Run the report helper.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const result = await env.exec('python3 /opt/kortix/helpers/report.py');
        if (!result.ok) throw result.error;
        if (result.value.exitCode !== 0) throw new Error(result.value.stderr);
        return { content: [{ type: 'text', text: result.value.stdout }], details: { rules } };
      },
    }],
  };
});
```

`resources.list()` returns names, repository paths, sizes, and SHA-256 digests.
`readText` requires UTF-8. `readJson` parses JSON. `readBinary` returns copied
bytes. Returned JSON and binary data can be changed without changing the bundle.
`resources` is optional in the SDK type for older callers; new workers always provide it.

The environment downloads its files through the authenticated session API before
reporting readiness. The response uses the session's pinned commit, even after
the default branch changes. It excludes worker resources. This download runs no Pi
code. The environment runs neither Pi nor OpenCode for a Pi session.

Limits are 64 worker files, 64 environment files, and 8 MiB combined decoded bytes.
Sources must be regular Git files. Missing files, symlinks, submodules, `.git`,
`.env` and `.env.*` files, traversal, overlapping targets, invalid modes, and corrupt bytes fail.
Paths and resource names are case-sensitive. Declare each file explicitly.
Credentials belong in secret grants, never resource files.

Read-only permissions prevent ordinary writes; trusted code with owner or root
access can change permissions. They are not a security boundary. Seed tracking
lives with the environment. It survives restart, not environment deletion.
Working-file backup and restoration remain a separate implementation phase.
YAML v2 rejects `resources` until the OpenCode resource adapter exists.

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

## Durable custom state

`context.state` stores JSON in PostgreSQL through the session storage API. It
requires no environment, local file, or Durable Object. State belongs to one
session. Replacing its worker retains state; another session starts independently.
Only active custom callbacks can read or change it. Retaining a namespace handle
for the next tool or lifecycle callback is supported.

```ts
const counter = await context.state.open('counter', {
  schemaVersion: 1,
  initialValue: { count: 0 },
});
const saved = await counter.update(value => ({ count: value.count + 1 }));
const current = await counter.read();
```

`open` initializes a missing namespace once. `read` returns a detached snapshot
with `revision`, `schemaVersion`, and `value`. `update` commits a new revision
before returning. Concurrent updates use compare-and-set in PostgreSQL; conflicts
retry against current state, up to eight attempts. Update and migration callbacks
must be pure: they can execute again. Do not call tools, send messages, or perform
external writes inside them. This does not make arbitrary tool execution exactly-once.

To change a state schema, supply an explicit migration. A failed migration leaves
the stored value unchanged. Older code rejects a newer schema on read and update.
The platform does not change a session's pinned code automatically.

```ts
const counter = await context.state.open('counter', {
  schemaVersion: 2,
  initialValue: { count: 0, label: 'Reports' },
  migrate(previous) {
    if (previous.schemaVersion !== 1 || typeof previous.value !== 'number') {
      throw new Error('Unsupported counter state');
    }
    return { count: previous.value, label: 'Reports' };
  },
});
```

The migration example upgrades a version-one numeric value. Production migrations
must validate the actual previous shape. Rollback requires code that understands
the committed schema; schema downgrade is rejected. This is one namespace per
transaction, not a transaction across namespaces or external side effects.

Limits: 64 KiB per JSON value, 128 namespaces, and 4096 committed writes or 16 MiB
of state history per session. Values allow finite JSON only, at most 64 levels
and 20000 nodes. State history follows session retention and deletion; it is not
a secret store or a file store. Namespace removal and history compaction are not
yet exposed. Reset a value with `update` without resetting its revision.

A turn state write uses the same ownership fence as its transcript. An expired
owner cannot commit through that fence. Callback cancellation prevents new writes;
it cannot undo a write already committed. A definitive validation/quota rejection
leaves normal conversation storage writable. An uncertain storage outcome fails
closed until recovery proves the result. An API without the `agent-state` route
rejects state use; the worker never falls back to volatile memory.

The [stateful example](../packages/sdk/examples/14-pi-stateful.ts) needs the
`increment_counter` tool permission. Run it once, stop/resume the session, and
run it again. The values must be 1 then 2. A new session must start at 1.

To test it in your own project:

1. Declare a `stateful` agent in the version 3 manifest, with no connector,
   secret, or skill grants.
2. Add `.kortix/pi/agents/stateful.md` with a prompt that uses the counter tool,
   `permission: { '*': deny, increment_counter: allow }`, and a supported model.
3. Copy the example to `.kortix/pi/agents/stateful.ts`. Replace its repository
   import with `import { definePiAgent } from '@kortix/sdk/pi'`.
4. Commit the files. Start a new `stateful` session from that commit. Ask it to
   call `increment_counter` exactly once, then stop and resume that session.
5. Call the tool again. Confirm 1 then 2, preserved chat history, and no
   environment creation. Start another session and confirm its first value is 1.

The 2026-09-10 preview check also exercises a failed update, a forward schema
migration, concurrent HTTP writes, and browser submission/reload. See
[verification evidence](PI_WORKER_VERIFICATION.md#2026-09-10--custom-state-preview-verification).

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
