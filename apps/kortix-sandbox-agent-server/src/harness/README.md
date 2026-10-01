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
| `pi/runtime.ts` | The in-process pi `Agent`: model, tools, skills, turns, transcript, durability |
| `pi/boot.ts` | Session boot: the same host steps as OpenCode, then `pi-ready` |
| `pi/surface.ts` | The raw OpenCode-compatible routes, answered in-process |
| `pi/wire.ts`, `pi/transcript.ts` | pi events → OpenCode wire frames; the transcript store |
| `pi/interactions.ts`, `pi/tools.ts`, `pi/model.ts` | Permissions/questions, workspace tools, gateway model |
| `../routes/` | Controllers, authentication, request parsing, HTTP status/headers, gzip and SSE delivery |

## One host relay (E12)

Every callback a box makes to apps/api lives in `shared/`, with Kortix names
and the body types of `@kortix/api-contract/runtime-relay`. An adapter decides
WHEN a turn begins or ends and what its identity is; the shared module owns the
route, the body, the credential, the retries and the dead-token breaker.

| Module | Callback |
| --- | --- |
| `shared/turn-relay.ts` | `POST /projects/:id/turn-stream` (initial-turn claim, `turn_accepted`, `turn_abandoned`, `runtime_session` pin, `turn_begin`, `end`, memory-guard end), `/turn-question`, `/turn-permission` |
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
(`HarnessDiagnosticsService.capabilities`: all nine on OpenCode,
`session.subagents` on pi). The pre-W3 flat fields (`opencode`, `opencode_pid`,
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

## The pi harness

> **Direction: pi replaces OpenCode.** OpenCode support is temporary and will
> be dropped. Kortix moves every session to pi once pi is verified to work for
> everything OpenCode does today — the gaps are listed at the end of this
> section. Until then OpenCode stays the default. When the move is complete,
> `open-code/` and the `opencode` harness id are removed.

pi (`@earendil-works/pi-agent-core`) is bundled into the daemon binary and runs
INSIDE the daemon process. There is no child process, no port, no RPC and no
second sandbox: pi's built-in `bash`/`read`/`write`/`edit` run on
`NodeExecutionEnv` over `/workspace`, Kortix adds `glob`/`grep` (ripgrep) and
`question`. Every model request goes to the Kortix LLM gateway through the
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

### Config releases

With the project's `config_releases` flag on, pi runs the base branch's
current config release, exactly as OpenCode does (`pi/config-release.ts`,
contract in `services/config-release/`). A release is the same archive under
`/opt/kortix/config/<release_id>`, verified against its Git blob IDs and
sealed read-only. pi reads three things from it: the compiled governance
(`KORTIX_COMPILED_AGENT_CONFIG`, the agents), `skills/`, and `pi/`, its own
config dir (`pi.config_dir`, else `harnesses/pi`, else `.kortix/pi`: skills,
extensions, prompts, `settings.json`), which the API composes into the release.
The rest of the archive (`opencode.json`, `tools/`, `plugins/`) is OpenCode's
and pi ignores it, so a commit that breaks only those files is a working config
on pi.

- **Boot.** `runPi` starts the choice beside the repository checkout, and
  `lifecycle.start()` waits for it: the desired release, then the last release
  this box proved (`current.json`), then the image default (managed skills and
  the provisioned governance). `/workspace` is read only while the flag is off.
- **Convergence** (`POST /kortix/config/converge`, the 60 s runtime-truth tick,
  one pass after ready). pi applies a release in place: the governance goes
  into the runtime's env, the skill directory moves to `<release>/skills`, and
  `PiRuntime.reconfigure()` re-reads both. A release that changes anything
  under `pi/` other than its skills (extensions, prompts, settings, which only
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

Permission rules follow OpenCode's semantics (`pi/interactions.ts`): a per-tool
action, or a glob-pattern -> action map matched against the `bash` command line
or a workspace tool's path, with the longest matching pattern winning and `*`
the weakest. A pattern map is never collapsed to its `*` entry, and a `deny`
outranks an earlier "always" reply on the same tool.

### Extensions

pi's own extension system runs every extension. The root `Agent` lives inside
pi-coding-agent's `AgentSession` (`pi/extensions/host.ts`), which owns the
loader, the real `ExtensionRunner`, tool wrapping, `input` and
`before_agent_start` on each prompt, extension commands, and `/skill:` and
prompt-template expansion. A package from https://pi.dev/packages runs
unmodified: Kortix writes no per-extension code. Kortix keeps the model (the
gateway provider is registered with pi's `ModelRuntime` only to pass its auth
check), the tools, the wire, and the permission policy, which runs BEFORE any
extension `tool_call` handler. pi's compaction and auto-retry are off: the
transcript and the product own them.

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
resumes it after a restart. Types: `general` (all workspace tools), `explore`
(`bash`/`read`/`glob`/`grep`), and every compiled agent with `mode: subagent`
or `all`. A child gets no `task` (no nesting) and no `question`. Several task
calls in one message run concurrently; a batch that includes any other tool
stays sequential. A child session is read-only (prompts to it answer 501).
A child's calls are checked against the subagent's own rules and the session's
rules; a `deny` from either wins, so delegating never unlocks a denied call.

Not supported by pi today (answered honestly, never silently): session rewind
(`/session/:id/revert`, 501 `feature_not_supported`), slash commands
(`/session/:id/command`), summarize/compaction, MCP/connector tools, todo
tools, warm-seed capture, `ctx.ui` prompts from extensions. `/kortix/health` reports `harness: 'pi'`
and keeps `opencode: <state>` as the compatibility field the control plane
already reads for readiness.

## Config provider is a host service, not harness logic

`src/services/config-provider/` (the `git` / `prefer-s3` / `require-s3` project
acquisition coordinator, #7221) stays outside `src/harness/`. It
depends only on `src/lib/` (`config`, `git`, `logger`) and knows nothing about
any harness. Both `open-code/boot.ts` and `pi/boot.ts` call
`materializeProject(cfg, { bootMark, onSummary })` at the point where the cold
boot acquires the workspace. `contract/boot-state.ts` carries the outcome:
`configProvider` (reported in `/kortix/health` as `config_provider`) and
`deferredHistoryBackfill`.

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
