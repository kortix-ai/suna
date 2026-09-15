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

`kortix.yaml` declares each agent's behavior, grants, and file references. This is
now the preferred authoring format. Source files remain in Git. The API resolves
them at one commit, then builds one immutable `.mjs` artifact per selected agent.
The worker downloads that artifact; it does not clone the repository.

```yaml
kortix_version: 3
config_dir: .kortix/shared
default_agent: reviewer
agents:
  reviewer:
    connectors: none
    secrets: none
    skills: none
    workspace: runtime
    config:
      description: Review supplied text
      model: kortix/gpt-5.6-luna
      temperature: 0.2
      permission:
        '*': deny
        review_text: allow
      prompt:
        file: prompts/reviewer.md
      pi:
        source: agents/reviewer.ts
```

- `config.prompt` accepts inline text or `{file: repository/path.md}`. A referenced
  file supplies exact prompt text; frontmatter inside it is also prompt text.
- `config.pi.source` selects one TypeScript or JavaScript factory. Its relative
  imports can reference other regular files inside the repository. Only reachable
  imports are bundled. Files unrelated to the selected agent are not read.
- `config_dir` holds shared skills, commands, and the optional `package.json` and
  `package-lock.json`. File references under `config` are relative to the repository,
  not this directory. The compiler pins dependencies to that lock.
- Custom code and its imported constants execute in the worker. Working files,
  shell commands, and installed workspace dependencies live in the environment.
  Custom code uses `env` to access them. Declaring a source file does not copy the
  repository into the environment. `resources` controls explicit file placement.
- The editor reads the effective behavior. Saving it updates YAML and its declared
  prompt file in one Git commit. It preserves the custom source and resource
  declarations. File pointers themselves are authored in YAML.

Change `kortix_version` to `2` to select OpenCode. The same shared behavior fields,
inline/file prompt, agent names, grants, and `config_dir` compile for both versions.
`config.pi.source` applies only to Pi. Native OpenCode plugins keep their existing
OpenCode configuration. Pi code and OpenCode plugins are different APIs; changing
versions does not translate extension code. Pi resource placement currently remains
v3-only; an OpenCode adapter for those declarations is still outstanding.

The API starts prebuilding after the Git push response finishes, when the upstream
has updated its refs. Compilation runs in the background. If the exact artifact
is still absent at session start, the API compiles it on demand.
A running session keeps its selected agent and source SHA. Editing files in its
environment does not modify the worker. Commit configuration changes and create a
session from the new commit. Declare agents on the configured project default
branch before starting sessions; `base_ref` selects their source revision.

Session creation reads the selected agent's model from that source revision.
An explicit session model wins, followed by an agent model preference, the compiled
agent model, and project/account/platform defaults. Account entitlement still
applies. The saved session model drives SDK prompts, so an omitted request model
does not replace the compiled choice with a platform default.

Existing projects retain the legacy convention when `config` is absent:
`<config_dir>/agents/<name>.md` supplies behavior and the matching `.ts`, `.js`, or
`.mjs` supplies optional Pi code. An explicit `config: {}` disables that implicit
inheritance. Missing explicit file references fail compilation.

Without a shared `config_dir`, v3 defaults to `.kortix/pi` and v2 to
`.kortix/opencode`. Legacy `pi.config_dir` and `opencode.config_dir` remain accepted.
The Pi compiler rejects conflicting legacy directories and unknown runtime fields.

`sandbox` selects the execution environment template. The platform owns the worker
image and identity. `workspace: runtime` leaves the environment without a repository
checkout. Its worker can fetch the pinned bundle, but its credential cannot clone
the repository or select another agent or release.

## Legacy agent Markdown

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

Point `config.pi.source` at a `.ts`, `.js`, or `.mjs` file. Legacy agents discover
exactly one matching file beside their Markdown.
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

## Running tool output

A tool's fourth `execute` argument is Pi's `onUpdate` callback. Send the current
text snapshot with it. Each update replaces the preceding snapshot. The SDK and
chat display it while the tool runs. Return the final result normally.

```ts
async execute(_id, _params, signal, onUpdate) {
  let output = '';
  const result = await env.exec('npm test', {
    abortSignal: signal,
    onStdout(chunk) {
      output += chunk;
      onUpdate?.({ content: [{ type: 'text', text: output }], details: {} });
    },
    onStderr(chunk) {
      output += chunk;
      onUpdate?.({ content: [{ type: 'text', text: output }], details: {} });
    },
  });
  if (!result.ok) throw result.error;
  return { content: [{ type: 'text', text: output }], details: { exitCode: result.value.exitCode } };
}
```

The command runs in the environment. The callback and formatting run in the
worker. Pure JavaScript tools can use `onUpdate` without starting an environment.
The built-in Bash tool uses the same streaming path.

Remote output is capped at 2 MiB per stream. Callbacks receive each accepted
chunk once, followed by any truncation marker. Older daemons return buffered
output at completion until upgraded.
Environment ensure upgrades older daemons to runtime version 3 in the existing
sandbox. The upgrade preserves working files and does not install Pi or OpenCode.
An environment already attached to a running worker upgrades on its next ensure
(for example, after reopening the stopped session).

A lost connection fails the command;
the worker does not repeat execution. Stop cancels the remote process group.
Callback failures also cancel execution. Late updates cannot replace a terminal
result. Final results persist in conversation history; intermediate snapshots
are live progress and are not a separate durable log.

## Files required by custom code

Declare files separately from source imports. The compiler reads their bytes from
the same Git commit as the agent code. No environment checkout is needed to read
a worker resource. Only the selected agent's declarations enter its artifact.

```yaml
kortix_version: 3
default_agent: reporter
agents:
  reporter:
    workspace: runtime
    resources:
      worker:
        rules: assets/rules.json
      environment:
        - source: assets/template.txt
          target: /workspace/template.txt
          mode: seed
        - source: assets/deletable.txt
          target: /workspace/deletable.txt
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
      name: 'inspect_rules', label: 'Inspect rules', description: 'Read bundled rules without compute.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: JSON.stringify(rules) }], details: { rules } };
      },
    }, {
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
YAML v2 supports the same `resources.environment` declarations. OpenCode installs
these files in its single sandbox before starting custom code. The session stores
an immutable resource commit; restart and replacement reuse it. Reading the
resource manifest never starts another sandbox. V2 bundles all enabled agents’
environment resources with an aggregate 8 MiB limit, then serves only the selected
agent’s files. Compiled OpenCode boot reads matching resource bytes directly from its bundle,
without another API download. Other boot paths fetch the pinned release.
Existing sessions without a resource pin perform no resource fetch.
V2 rejects `resources.worker`: that API requires Pi.

To switch the environment example to OpenCode, set `kortix_version: 2`, remove
`resources.worker`, and replace native Pi source with OpenCode plugins or tools.
The `source`, `target`, and `mode` environment declarations stay unchanged.
An OpenCode tool can read `/opt/kortix/helpers/report.py` or
`/workspace/template.txt` directly. A Pi tool uses `context.env` to access
those paths. Native custom code still needs a runtime-specific implementation.

### Test bundled files

Use the `reporter` YAML and factory above. Its Markdown must permit
`inspect_rules` and `make_report`. Set a supported model. For the helper, use
`print(open('/workspace/template.txt').read())` in `scripts/report.py`.
Put valid JSON in `assets/rules.json`. Add recognizable text to `assets/template.txt`
and `assets/deletable.txt`.

1. Commit the agent source, Markdown, YAML, rules, template, and helper together.
   Start a new session from that commit.
2. Ask for `inspect_rules`. Confirm its value matches Git. This tool must leave
   the environment absent.
3. Ask for `make_report`. Open Files and Terminal. Both must read
   the same template under `/workspace`.
4. Edit the template and delete `/workspace/deletable.txt`. Stop and resume the session.
   The edit must remain. The deleted seed must stay absent. File and terminal
   access must reconnect without waiting for a cached provider token to expire.
5. Commit different rules and helper content. The old session must retain its
   original release. A new session must receive the new release.
6. In a separate release, add an undeclared resource read or invalid JSON. The call must fail explicitly.
   If the factory reads invalid JSON, the worker must fail before readiness.
7. Run a helper that sleeps before writing a marker. Press Stop while it runs.
   The marker must remain absent after the sleep period. Send another prompt.

For automated cancellation tests, use `prompt_async` or keep the prompt request
in flight. Waiting for a synchronous prompt response tests completion, not Stop.

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

Relative imports stay inside the repository. The compiler bundles
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

Limits: 256 imported source files, 8 MiB total imported source; 128 locked production packages;
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

## Change the session model

Use the chat model picker, `session.changeModel("kortix/<model>")` in the SDK,
or `kortix sessions model <session-id> <model>` in the CLI. The API validates the
model against the project's gateway and the account's access.

The model applies when the worker accepts a new prompt. Running, queued, and
question/permission-paused prompts keep their accepted model. Their snapshot
includes context, output, image, and reasoning limits. Worker replacement
restores that snapshot. Retrying the same message ID keeps the original selection.

Changing the model does not rerun custom initialization or replace the compiled
agent. Source commit, instructions, hooks, tools, resources, state, permissions,
and environment remain unchanged. The next prompt uses the selected model's
capabilities. Unsupported reasoning and new image attachments fail before admission.
Manual compaction and commands use the same selection rules. A command with an
explicit model must match the saved session model.

The API returns `applies_to: "next_prompt"`. A configuration read failure returns
`503` before accepting a new prompt. An older running worker returns `409` until
it is upgraded. Stop/resume also upgrades workers created before the model
endpoint existed. Live agent switching remains unsupported.

## Provider context overflow

When an ordinary provider request rejects an existing conversation for context
overflow, Pi can summarize and retry once per prompt. Recovery reuses recorded
tool results. A completed current tool batch remains in native context when it
fits within 16,000 estimated tokens and one quarter of the model context window.
Larger batches become summary text. The model can then request another tool call;
custom tools with external effects still need application-level idempotency. Custom context
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

Remote resources and prompts use connector discovery and the gateway. Resource
subscriptions and server-initiated sampling/elicitation remain unsupported.
OpenCode `mcp` configuration and Pi CLI settings are not imported automatically.
Local stdio servers use the custom module below.


## Local MCP servers in the environment

The custom Pi module declares each local server. Its declaration enters the same
commit-pinned `.mjs` artifact as the agent. Registration starts no process and
allocates no environment. The first `mcp_list` starts the environment and server.
Pi remains in the worker. The environment runs the MCP executable and `kortixd`.

For a repository helper, declare its placement in `kortix.yaml`:

```yaml
kortix_version: 3
default_agent: reviewer
agents:
  reviewer:
    workspace: runtime
    secrets: none
    resources:
      environment:
        - source: scripts/files.mjs
          target: /opt/kortix/helpers/files.mjs
          mode: read_only
```

Then declare the process in `.kortix/pi/agents/reviewer.ts`:

```ts
import { definePiAgent } from '@kortix/sdk/pi';

export default definePiAgent(() => ({
  mcp: {
    files: {
      type: 'local',
      command: ['node', '/opt/kortix/helpers/files.mjs'],
      cwd: '/workspace',
      timeout: 30000,
    },
  },
}));
```

The helper must implement MCP over newline-delimited JSON-RPC on stdin/stdout.
Send diagnostic logs to stderr. Command arguments are passed directly, without a
shell. Install dependencies in the environment image or bundle the helper first.
The runtime does not run `npm install`. Linux environments require Python 3 for
process supervision; the standard image includes it.

For credentials, grant the project secret to the agent in YAML and add
`environment: { API_TOKEN: '{env:MCP_TOKEN}' }` to that server's declaration.
Only explicitly mapped values and a small OS environment enter the child.
The daemon's API token is not inherited. Missing secret references fail before
process startup. Secret values do not enter tool schemas or discovery results.
A server can still return its own credentials; configure trusted servers.

| Tool | Input and behavior |
| --- | --- |
| `mcp_list` | `server`, optional `kind` (`tools`, `resources`, `templates`, `prompts`), optional `cursor`. Returns discovery data and `connectionId`. |
| `mcp_call` | `server`, `connectionId`, discovered `tool`, and `arguments`. |
| `mcp_read_resource` | `server`, `connectionId`, and `uri`. |
| `mcp_get_prompt` | `server`, `connectionId`, `prompt`, and optional string `arguments`. |
| `mcp_disconnect` | `server` and `connectionId`. Stops an idle server and clears its process state. |

Configure permissions in the agent Markdown frontmatter. For example,
`permission: { mcp_call: { '*': ask, 'files:delete': deny } }` uses the existing
permission UI. Patterns are `server:tool`, `server:uri`, `server:prompt`, or
`server:kind`; disconnect uses the server name. Approval happens before execution.
These permissions govern MCP requests, not the server's internal filesystem access.
A started server has the environment user's filesystem privileges.

A connection preserves process state between requests. It expires after 60 seconds
without requests. Configuration or secret changes invalidate old connection IDs.
Calls with stale IDs fail before execution; discovery returns a new identity.
An approval wait can outlast that idle window. In that case, rediscover the
server and request approval for the new call; the expired call does not run.
Each server keeps separate process state. Calls through the agent follow the
existing environment-operation queue. A busy server rejects another request.
At most 16 configured processes run per environment. Each request defaults to
30 seconds, configurable from 1 to 60,000 milliseconds. Requests are limited to
1 MiB; response frames to 12 MiB; normalized text to 512 KiB.

Stop, timeout, malformed output, and connection failure terminate that server's
process group. A supervisor also terminates children after daemon death. Failed
calls are never replayed automatically. Inspect any completed side effects before
retrying. MCP tool errors remain errors. Text, supported images, resources, prompts,
and paginated discovery use the same content handling as remote connectors.

MCP process state is not durable. Stopping or replacing the environment loses it.
Working files follow the environment's existing disk lifecycle. Conversation
results and image attachments use the existing durable chat storage. MCP side
effects cannot be undone through chat rewind. A turn containing MCP operations
refuses file rewind. Active MCP processes also block other workspace checkpoints
and rewind; disconnect them first. The shared lock survives daemon replacement.

Subscriptions, notifications as live product updates, sampling, elicitation,
interactive authentication, and automatic OpenCode configuration migration remain
separate work. Use project connectors for remote HTTP MCP servers.
