# Internal harness boundary

`harness.ts` is the only module that imports a concrete adapter. It resolves
the implementation and exposes a definition for configuration, boot, and service
creation. The import rules are in [ARCHITECTURE.md](../../ARCHITECTURE.md). Two adapters are registered: `opencode` (the default) and `pi`. An
unknown id fails the boot.

```ts
const cfg = loadConfig()                 // reads KORTIX_HARNESS, then the selected adapter's env
const selected = resolveHarness(cfg)     // openCodeDefinition | piDefinition
const runtime = selected.createService(cfg, projectEnv)
await runtime.lifecycle.start()
```

## Selection

`KORTIX_HARNESS` (`opencode` | `pi`; unset means `opencode`) is set by apps/api
at provisioning (`buildSessionSandboxEnvVars` → `selectSessionHarness`): pi when
the project's `pi_harness` feature flag is on, or when the manifest says
`runtime: pi`, and the `llm_gateway` flag is on (pi has no model path without
the gateway); OpenCode otherwise. `loadConfig` reads it BEFORE the adapter
loads its own environment, so only the selected adapter's variables are parsed.
There is no per-request switching: one box, one harness, for the life of the
session (a restart or resume re-reads the selection).

## Ownership

| Location | Responsibility |
| --- | --- |
| `harness.ts` | Resolution, `loadConfig`, the boot context and the union helpers every box uses |
| `contract/` | Named host-facing operation contracts (`control`, `diagnostics`, `queries`, `proxy`, `lifecycle-contract`, `boot-state`, `server`); no router dependencies |
| `shared/` | Adapter-neutral steps both adapters call: agent env file, `on_boot`, attachment stripping, the host facts of `/kortix/health` (`host-health.ts`), and every daemon-to-API callback (see below) |
| `../services/runtime-assets/port.ts` | Harness maintenance contract, owned by the service that consumes it |
| `open-code/service.ts` | Composition over one lifecycle; native typed ports |
| `open-code/boot.ts` | Native cold boot, warm seed/adoption, first turn, reconciliation and relays |
| `open-code/control.ts`, `open-code/diagnostics.ts`, `open-code/queries.ts` | Native execution, configuration, state queries, diagnostics and attachments |
| `open-code/proxy.ts` | Native readiness, upstream client, timeout classification and payload processing |
| `open-code/events.ts`, `open-code/event-bus.ts` | Native event reading, session identity and recovery instructions |
| `open-code/config.ts`, `open-code/paths.ts` | Native environment, authored config discovery and paths |
| `open-code/assets.ts` | Native binary/plugin updates and skill placement |
| `open-code/background.ts`, `open-code/resource-diagnostics.ts`, `open-code/quick-queue-interrupt.ts` | Native offload, turn guard, tool-boundary queue interrupt and diagnostic projection |
| Other `open-code/` modules | Native database, projections, pins, attachments, audit and recovery |
| `pi/service.ts` | Composition; loads pi lazily so an OpenCode boot never pays for it |
| `pi/runtime.ts` | The in-process pi `Agent`: model, tools, skills, the root `AGENTS.md`, turns, transcript, durability |
| `pi/boot.ts` | Session boot: the same host steps as OpenCode, then `pi-ready` |
| `pi/surface.ts` | The raw OpenCode-compatible routes, answered in-process |
| `pi/turn-events.ts`, `pi/transcript.ts` | pi events → Kortix session events (`@kortix/api-contract/transcript`); the transcript store |
| `pi/interactions.ts`, `pi/tools.ts`, `pi/model.ts`, `pi/sampling.ts` | Permissions/questions, workspace tools, gateway model, the agent's `temperature`/`top_p`/`steps` on each model request |
| `../routes/` | Controllers, authentication, request parsing, HTTP status/headers, gzip and SSE delivery |

## One host relay (E12)

Every callback a box makes to apps/api lives in `shared/`, with Kortix names
and the body types of `@kortix/api-contract/runtime-relay`. An adapter decides
WHEN a turn begins or ends and what its identity is; the shared module owns the
route, the body, the credential, the retries and the dead-token breaker.

| Module | Callback |
| --- | --- |
| `shared/turn-relay.ts` | `POST /projects/:id/turn-stream` (initial-turn claim, `turn_accepted`, `turn_abandoned`, `runtime_session` pin, `turn_begin`, `end`, `steer_read`, memory-guard end), `/turn-question`, `/turn-permission` |
| `shared/projection-relay.ts` | `POST /platform/runtime-projection`; the adapter registers its state reader |
| `shared/audit-relay.ts` | `POST /projects/:id/sessions/:id/audit/events`: sanitize, batch, spool; batches carry `source: 'runtime'` and the harness id. pi feeds it every frame it publishes (`PiRuntimeHooks.onFrame`), so pi sessions have a tool audit trail |
| `shared/boot-timeline-relay.ts` | `POST /platform/boot-timeline` |

A callback added here reaches every harness. The API accepts the pre-W3
spellings (`opencode_session_id`, kind `opencode_session`) from older daemons.

## Health and capabilities (E19, E1)

`GET /kortix/health` is composed by `routes/kortix/health.ts`: the host facts
(`shared/host-health.ts`), the harness's closed `harness` block
`{ id, version, state, ready, error, session, turn, details }`
(`HarnessDiagnosticsService.health`; OpenCode's pid/port and pi's model and
extensions are in `details`), `runtimeReady` computed once from both, and
`capabilities`: the host's `file.import`/`file.append`, the control's
`config.release.v1` (both harnesses), and the session features the runtime serves
(`HarnessDiagnosticsService.capabilities()`, read on each health call: all eleven
on OpenCode 1.18.15 and later, the ten without `session.steer` on an older or
unknown OpenCode version; `session.subagents`, `session.compact`,
`session.commands` and `session.steer` on pi). The pre-W3 flat fields (`opencode`, `opencode_pid`,
`opencode_port`, `opencode_session_id`, …) are composed from the block in
`routes/kortix/legacy-names.ts` for an older API.

The host retains its entrypoint and monitor mode (`src/app/`), Git/files/PTYs,
authentication, static previews, the LLM/connector proxy, the resource sampler,
the event sequencer, the managed-skill overlay (`src/services/skills/`) and the
CLI/daemon update scheduler (`src/services/runtime-assets/`). These call service
ports for harness behavior. They import no adapter module; adapters import no
other adapter, no route and nothing in `src/app/`. The app hands a boot what it
needs through `HarnessBootContext` (`serve` starts the HTTP server).
`bun run lint` enforces all of it.

## Steering

`POST /kortix/runtime/sessions/:id/steer` takes the `/prompt` body with
`message_id` required (400 without it), behind the same auth, readiness gate
and `X-Kortix-Turn-Verb` header. The running turn reads the message at its next
step boundary, after the running tool batch; the turn does not stop. Answers:
`202 { message_id, steered: true }`; `200 { deduplicated: true }` for an id
already admitted, steered or on the transcript; `409 { code: 'no_active_turn' }`
when no turn runs (nothing is stored, the caller sends a prompt);
`501 { code: 'feature_not_supported' }` on OpenCode older than 1.18.15.

- **Read.** pi: the loop emits the message as a user message
  (`steeringMode: 'all'`: every message steered before one boundary arrives
  together). The daemon publishes it on the wire then, under its id, and the
  replies after it name it as `parentID`. OpenCode: the first assistant
  `message.updated` whose `parentID` is the steered id. Both relay `steer_read`
  once per id (`shared/turn-relay.ts`).
- **Withdraw.** The retract (below) on an unread steered message removes it
  (pi: from kortixd's queue in front of `agent.steer()`; pi can only clear its
  queue, so the rest are steered again in order). A read one answers
  `409 { code: 'message_read' }`.
- **Leftovers (pi).** A turn that ends on its own with unread steered messages
  starts the next turn with them, in the same queue slot: the first is its
  prompt, the rest are read before its first model call. A stopped turn (Stop,
  Quick Queue, the no-progress watchdog) drops them. OpenCode needs neither: its
  loop does not end while a newer user message is unanswered.
- **Gaps.** A steered message keeps the turn's model, agent and variant. On pi
  it does not run extension `input` handlers, `/skill:` or prompt-template
  expansion (a prompt does). Unread steered messages live in memory: a daemon
  restart loses them.

## Retract

`POST /kortix/runtime/messages/:sid/:mid/retract` takes back a user message no
model call has read (`runtime.retract.v1` in `/kortix/health` `capabilities`),
behind the same auth, readiness gate and `X-Kortix-Turn-Verb` header. apps/api
uses it to cancel a forwarded prompt, to hold forwarded prompts after a Stop,
and to re-place a stranded prompt. Answers: `200 { retracted: true }`; `404`
when the session holds no such message; `409 { code: 'message_read' }` when a
model call read it (its turn runs or ran), and it stays.

- **pi** decides from its own state: an unread steered message, a prompt
  admitted behind the running work that has not started, and a `no_reply`
  message no turn has read (pi omits its session entry from the model context)
  are retracted. A retracted id may be sent again. The `DELETE` verb and the
  compatibility `DELETE /session/:id/message/:mid` answer the same way, so an
  older API gets the fix too.
- **OpenCode** cannot tell a read message from an unread one, so apps/api
  proves "unread" from the transcript first (`reachedPlacement`). The adapter
  deletes the message whole when idle; when the loop runs and refuses that, it
  deletes every part, and OpenCode's loop skips a user message with no parts.

## The pi harness

> **Direction: pi replaces OpenCode.** OpenCode support is temporary and will
> be dropped. Kortix moves every session to pi once pi is verified to work for
> everything OpenCode does today — the gaps are listed at the end of this
> section. Until then OpenCode stays the default. When the move is complete,
> `open-code/` and the `opencode` harness id are removed.

pi (`@earendil-works/pi-agent-core` and `pi-coding-agent`, 1.0.3) is bundled
into the daemon binary and runs INSIDE the daemon process. There is no child
process, no port, no RPC and no second sandbox: pi-coding-agent's built-in
`bash`/`read`/`write`/`edit` run on `/workspace` in this process, Kortix adds
`glob`/`grep` (ripgrep) and `question`, and the hosted tools (see "Hosted
tools" below). A project needs no `harnesses/pi/` file for any of them.
Every model request goes to the Kortix LLM gateway through the
daemon's localhost LLM proxy, under the same `kortix` provider id OpenCode uses.

What the product sees is unchanged: pi's events are reshaped into the OpenCode
wire (`message.updated`, `message.part.updated`, `message.part.delta`,
`session.status`, `session.idle`, `permission.*`, `question.*`), served over the
same `/kortix/runtime/*` namespace and the same raw routes
(`/session`, `/session/:id/prompt_async`, `/session/:id/message`, `/config`,
`/agent`, `/provider`, `/permission/:id/reply`, …). One pi session is one Kortix
session: the root id is `ses_pi<sha256(sessionId)[:24]>`, deterministic, so a
restart resolves the same root and restores the transcript from
`$KORTIX_RUNTIME_STATE_DIR/pi/<session>.json`.

Config it reads (all set by apps/api for every session, harness-neutral values):
`KORTIX_MODEL` (the resolved session model), `KORTIX_COMPILED_AGENT_CONFIG`
(agent prompt, model, permission policy), `KORTIX_AGENT_NAME`, `KORTIX_LLM_BASE_URL`
+ `KORTIX_TOKEN`, the image-baked catalog at `/opt/kortix/llm-catalog.json`.
pi-only: `KORTIX_PI_STATE_DIR`.

`KORTIX_AGENT_NAME` (else the config's `default_agent`) is the session's
agent. A prompt that picks a primary agent of the compiled config runs its
turn on that agent: its prompt, permission policy, tool switches, sampling and
variant, and its `model` when the prompt names none. A prompt that picks none
runs on the session's agent, as on OpenCode. A pick of a subagent, a disabled
agent or an unknown name is logged and runs on the session's agent. pi
packages and extensions stay the ones the session booted with.

### Config releases

pi runs the base branch's current config release, exactly as OpenCode does
(`pi/config-release.ts`, contract in `services/config-provider/`). A release is
a checkout of the base branch under `/opt/kortix/config/<release_id>`, with
the repository's own layout, verified against its Git blob IDs and sealed
read-only. pi reads from it what it reads from `/workspace`: the compiled
governance (`KORTIX_COMPILED_AGENT_CONFIG`, the agents), `skills/` (and the
legacy `.kortix/opencode/skills`), the root `AGENTS.md` (else `CLAUDE.md`),
and its own config dir (`pi.config_dir`, else `harnesses/pi`, else
`.kortix/pi`: skills, extensions, prompts, `settings.json`), resolved inside
the release by `resolvePiProjectConfigDir`.
OpenCode's files (`harnesses/opencode`) are not pi's, so a commit that breaks
only those files is a working config on pi.

- **Boot.** `runPi` starts the choice beside the repository checkout, and
  `lifecycle.start()` waits for it: the desired release, then the last release
  this box proved (`current.json`), then the image default (managed skills and
  the provisioned governance). `/workspace` is read only when the box has no
  Kortix API, or an API from before config releases graduated answers `403
  feature_disabled`.
- **Convergence** (`POST /kortix/config/converge`, the 60 s runtime-truth tick,
  one pass after ready). pi applies a release in place: the governance goes
  into the runtime's env, the skill directories and the `AGENTS.md` root
  (`PiConfigReleases.projectRoot()`) move into the release, and
  `PiRuntime.reconfigure()` re-reads them. A release that changes anything
  in pi's config dir other than its skills (extensions, prompts, settings, which only
  a start reads) restarts the runtime in place instead: the same root, the
  transcript restored. Nothing else restarts, and the answer carries
  `reload: null` either way. A turn in flight, or one admitted behind it
  (`PiRuntime.idle()`), defers the apply; it is asked again after the download,
  right before the swap. A runtime that refuses the config keeps the previous
  one, and the release is quarantined on the box.
- **Reporting.** Health carries the same `config` block and `config_dir_sha`
  as OpenCode, and `harness.ready` requires `config.proven`. While a release
  owns the governance, a `/kortix/env` push of `KORTIX_COMPILED_AGENT_CONFIG`
  is dropped. The session notice (`/tmp/kortix/config-release.md`) is part of
  pi's system prompt while a release runs.
- **Not in a release.** npm pi packages (`harnesses.pi.packages`) and pi's own
  `<workspace>/.pi/extensions` discovery load when the runtime starts, as
  before. A change to them reaches a session at its next boot or restart.

Boot marks: `git-identity`, `proxy-up`, `llm-proxy-started`, `repo-materialized`,
`pi-ready`, `initial-prompt-delivered`, `initial-turn-accepted`, `runtime-ready`.

A permission rule names a capability (`RUNTIME_PERMISSION_CAPABILITIES` in
`@kortix/api-contract/transcript`: `read`, `edit`, `bash`, `webfetch`, …), not
one harness's tool. Each adapter maps its tools onto them: pi's `write` is
`edit`, its `memory` is `edit` (`read` for the `view` command), and its
`web_search`/`image_search` and `scrape_webpage` follow `websearch` and
`webfetch` (`pi/interactions.ts` `toolCapability`); pi asks for them like any
other tool. A rule under the tool's own name wins over its capability. OpenCode's `pty_*` tools follow `bash`, and the
hosted `web_search`/`image_search` and `scrape_webpage` follow `websearch`
and `webfetch` (`open-code/lifecycle.ts` `capabilityToolRules`). The OpenCode
tools cannot ask, so they run only when the capability is `allow`. A rule is an
action, or a glob-pattern -> action map matched against the `bash` command
line or a workspace tool's path, with the longest matching pattern winning and
`*` the weakest. A pattern map is never collapsed to its `*` entry. pi's
request names the capability and the call's subject (`patterns`); an "always"
reply allows the capability for the session, and a `deny` still outranks it.
The reply is `RUNTIME_PERMISSION_REPLIES` (`once`, `always`, `reject`).

### Extensions

pi's own extension system runs every extension. The root `Agent` lives inside
pi-coding-agent's `AgentSession` (`pi/extensions/host.ts`), which owns the
loader, the real `ExtensionRunner`, tool wrapping, `input` and
`before_agent_start` on each prompt, extension commands, and `/skill:` and
prompt-template expansion. A package from https://pi.dev/packages runs
unmodified: Kortix writes no per-extension code. Kortix keeps the model (the
gateway provider is registered with pi's `ModelRuntime` only to pass its auth
check), the tools, the wire, and the permission policy, which runs BEFORE any
extension `tool_call` handler. pi's auto-retry is off: the product owns it
(`pi/transient-retry.ts`). pi's built-in `mcp`, `codemode` and `tool-search`
extensions are not loaded: a host passes them in, and Kortix passes none.

Three sources, in pi's own scopes:

| Source | Declared in | Installed in |
|---|---|---|
| system (every session) | `<agentDir>/settings.json` `packages`; `agentDir` = `KORTIX_PI_AGENT_DIR`, default `/opt/kortix/pi-agent` | `<agentDir>/npm`, when the image is built |
| project | kortix.yaml `harnesses.pi.packages` → `KORTIX_PI_PACKAGES` | npm sources: built once per package list by the API (apps/api/src/pi-packages, on change-request merge) as a PRE-BUILT bundle — one self-contained, minified ESM file per extension (deps inlined; pi's own modules read `globalThis.__kortixPiHost`) plus the package's own files minus the code that file inlined, type declarations, source maps and the root README/CHANGELOG — and the installed `node_modules` as a fallback. The daemon starts the download with the service (beside the repo clone), unpacks to `<KORTIX_PI_PACKAGES_DIR>/<digest>` (outside the repo) and imports each extension natively: no jiti, no install (`extensions/prebuilt.ts`). A package with no pre-built form, one whose file throws on import, or an entry with its own `extensions` filter loads from the fallback (`KORTIX_PI_PACKAGES_FALLBACK_URL`, fetched only then) through pi's loader |
| repo-local | `<workspace>/.pi/extensions/*.ts`, or a repo-relative path in `harnesses.pi.packages` | the repo itself |

A project entry for the same package overrides the system one. Nothing installs
at boot. pi installs a missing package on load (13.2 s for two packages,
measured), so `installedPackages()` drops an npm source that is not on disk at
its pinned version, refuses repository sources, and reports each drop under
`extensions.failed` in `[pi] runtime ready`. A package's extension loads through
pi's jiti loader. In the compiled daemon, pi supplies `typebox` and the
`@earendil-works/pi-*` peers as virtual modules: a compiled probe loaded a
TypeScript package importing both in 24 ms, and its tool ran.

In-process extensions are `InlineExtension`s (`{ name, factory }`): `subagents`,
and the hidden `kortix-turn`, which adds a prompt's `system` field for that turn.
Child sessions have no `AgentSession`; the runtime routes their tool, context and
provider hooks to the same runner. `ctx.ui` has no UI bound (`hasUI` is false):
tools and events work, TUI-only rendering does nothing.

`subagents` is OpenCode's `task` tool: input `{ description, prompt,
subagent_type, task_id? }`, the child id in the part's `metadata.sessionId`
(set while the child runs), output `task_id: <id>` + `<task_result>`. Each call
runs an in-process pi agent in a child session (`parentID` = root), with its
own wire transcript served by `/session`, `/session/:id`,
`/session/:id/message`, `/session/:root/children`, the state document and
`/kortix/runtime/messages/:id`, and persisted in the root's dump so `task_id`
resumes it after a restart. Types: `general` (all workspace and Kortix tools), `explore`
(`bash`/`read`/`glob`/`grep`), and every compiled agent with `mode: subagent`
or `all`. A child gets no `task` (no nesting) and no `question`. Several task
calls in one message run concurrently; a batch that includes any other tool
stays sequential. A child session is read-only (prompts to it answer 501).
A child's calls are checked against the subagent's own rules and the session's
rules; a `deny` from either wins, so delegating never unlocks a denied call.

### The conversation, compaction and slash commands

pi's `SessionManager` (in memory) is the model context: the agent's messages
are its projection. The state dump stores its entries (`entries`), and a
restart restores them, so a compaction or a context edit survives it. The dump
also keeps `agentMessages` for a daemon built before pi 1.0, which restores
from that field; this daemon reads it only when `entries` is absent.

pi's own compaction is on. It runs on demand (`POST /session/:id/summarize`),
when the context nears the model's window, and when a model request overflows
it or a reply is cut by the length limit (pi then retries that request once;
the failed attempt's error is withheld from the wire and lands on the message
only when the recovery fails). The wire carries it in OpenCode's shape: a user
message whose one part is `compaction` (`auto`, `overflow`), an assistant
message flagged `summary` with the summary text or an error,
`time.compacting` on the session while it runs, and `session.compacted`. The
transcript keeps every message. A project's `settings.json` in the pi config
dir sets `compaction.enabled`, `reserveTokens` and `keepRecentTokens`.
Subagent child sessions have no `AgentSession` and do not compact.

`GET /command` lists pi's prompt templates (`prompts/*.md` in the pi config
dir, and the templates of pi packages) as slash commands.
`POST /session/:id/command` runs one: it admits `/name arguments`, pi expands
the template, and the user message on the wire becomes the expanded text, as
on OpenCode. A command pi does not have is a 400. pi does not read OpenCode's
`commands/` directory.

Not supported by pi today (answered honestly, never silently): session rewind
(`/session/:id/revert`, 501 `feature_not_supported`), MCP/connector tools, todo
tools, warm-seed capture, `ctx.ui` prompts from extensions. `/kortix/health` reports `harness: 'pi'`
and keeps `opencode: <state>` as the compatibility field the control plane
already reads for readiness.

## Hosted tools

A tool that is not a harness's own (`bash`, `read`, …) is written once, as a
harness-neutral module, and the daemon runs it for whichever harness the box
runs (`../services/tools/`):

| Module | What |
| --- | --- |
| `services/tools/tool.ts` | The contract: a default export `{ description, parameters (JSON Schema), execute(args, context) }`, with `context` = `{ sessionId, agent, directory, env, signal }`. |
| `services/tools/kortix/<name>.ts` | The Kortix tools, one self-contained module each: `web_search` (Tavily), `image_search` (Serper), `scrape_webpage` (Firecrawl), `memory`, `show`. Each follows the project tool contract and imports only `node:*`, so `kortix tools eject <name>` copies the file into a project unchanged (the CLI embeds the same bytes, `apps/cli/src/kortix-tools.generated.json`). The web tools read `KORTIX_API_URL` and `KORTIX_TOKEN` from `context.env` and call the API's billed router proxy (`/v1/router/{tavily,serper,firecrawl}`); a box with no control plane calls the upstream with the project's own key. |
| `services/tools/host.ts` | `loadTools(root, compiled)`: the Kortix tools `CompiledAgentSet.kortix_tools` lists (all five when it is absent: no kortix.yaml `tools` key, or a config compiled before the key existed), then the project's (`project_tools`), imported from `root` (the working tree or the config release). A project tool replaces a Kortix tool of its name; a module that does not load is logged and skipped. `runTool` bounds the output (over 50 KB or 2000 lines: the whole text to a temp file, the head to the model). `sessionEnv` is `context.env`: the process env with the live agent env file over it. |
| `routes/kortix/tools.ts` | `POST /kortix/tools/:name` for an out-of-process harness: the box's tool-bridge key (`toolBridgeKey`, kept in the runtime state dir) or the control credential; `403` when the agent's tool access refuses the tool. |

- **pi** loads them at `start()` and registers each as an `AgentTool`
  (`pi/tools.ts` `createWorkspaceTools`); subagents get them too. A release
  that changes a project tool's declaration or a file in its module's folder
  restarts the runtime in place (`pi/config-release.ts` `startOnlyFiles`).
- **OpenCode** gets a plugin the daemon writes on every config compose
  (`open-code/tool-bridge.ts`, `~/.config/kortix-tools.js` and its tool list
  `kortix-tools.json`). Each tool is a stub that posts to the route above. Its
  `args` are the JSON Schema properties (OpenCode's non-Zod plugin path) and
  its `tool.definition` hook restores the exact schema, so optional arguments
  stay optional. A name the served config dir defines in its own `tools/`
  (the copies the template wrote before) keeps the project file.

**Tool access.** `CompiledAgent.tools` (kortix.yaml `agents.<name>.tools`) maps
a tool name to visible, with `*` for every tool not named; `toolAllowed`
(`@kortix/api-contract/runtime-relay`) reads it. pi filters the active tools
and denies a call to a hidden one, for the root and for a subagent (both
agents' maps must allow it). OpenCode reads the map as permission rules
(`open-code/tool-access.ts`): a removed tool is a `deny` after every other
rule, an allowlist is `*: deny` first, then the rules of the allowed tools at
the action they had; the compiled `tools` key is dropped, because OpenCode's
own reading turns `true` into `allow` and lets the agent's `permission`
re-open a removed tool.

## The workspace and config providers are host services, not harness logic

`src/services/workspace-provider/` (the `git` / `prefer-s3` / `require-s3`
project acquisition, #7221) and `src/services/config-provider/` (the config
release a boot needs) stay outside `src/harness/`. Each depends only on
`src/lib/` and knows nothing about any harness or about the other: both read
the S3 project snapshot through `src/lib/project-snapshot/`. The harness
composes them. Both `open-code/boot.ts` and `pi/boot.ts` call
`provideWorkspace(cfg, { bootMark, onSummary })` at the point where the cold
boot acquires the workspace, then hand the checkout to the config release
boot. The warm-seed adoption and monitor mode call the same function in `git`
mode. `contract/boot-state.ts` carries the outcome: `workspaceProvider`
(reported in `/kortix/health` as `config_provider`, its pre-rename wire name)
and `deferredHistoryBackfill` (`backfillAfterHydration` for an S3 start).

## OpenCode instance guard

OpenCode builds its per-directory services on first use and caches the result
forever, including an interrupted build. A Stop during the first turn of a
fresh instance can therefore break every later turn on the box.
`open-code/instance-guard.ts` prevents that in 3 steps:

1. **Warm.** The daemon requests `/experimental/tool/ids`, `/agent`, `/skill`,
   `/config/providers` and `/mcp` when the event stream connects and after
   every instance dispose. Loop-starting requests through the proxy wait for
   this warm-up, for 20 s at most.
2. **Heal.** After any aborted turn the daemon probes the same endpoints. Two
   503 answers in a row trigger `POST /instance/dispose` and a new warm-up.
3. **Recover.** A root turn that aborted before any output, with no stop
   request recorded, is a victim. The daemon disposes the instance, then
   re-prompts once through `turn-auto-resume.ts`. When that is not possible,
   the turn end carries the cause `RuntimeAbortedTurn`.

Every daemon path that aborts an OpenCode turn calls
`noteOpencodeStopRequested` first. A new abort path must do the same, or its
stops read as victims.

## Native features remain available

The common interface is not a feature limit. Host controllers register every
existing route and invoke named resolved operations. The compatibility proxy
port preserves catch-all forwarding: for OpenCode that is a real upstream
process, for pi an in-process dispatcher — either way a native feature without a
common method still reaches the harness. OpenCode-specific configuration,
events and full lifecycle operations stay typed inside `open-code/`; pi's stay
inside `pi/`. No silent feature fallback or harness switching is added.

`createService` does not spawn a process or subscribe to events. Controllers
receive the resolved service through dependency injection; `/kortix/runtime/*`
(and its pre-W3 alias `/kortix/opencode/*`) is a URL, not an implementation selector. The adapter cannot
register routes or receive a Hono context.

## Unchanged contracts

- Project folders, native config locations and configuration precedence.
- Environment variable names, defaults and loaded values (pi adds `KORTIX_PI_*`).
- Routes, response/event payloads, diagnostics and durable state filenames.
- Readiness gates, timeout policy and update ordering.
- SDK/UI behavior, Docker images and sandbox image selection.
