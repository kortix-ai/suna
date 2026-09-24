# Internal harness boundary

`harness.ts` is the only host module that imports a concrete adapter. It resolves
the implementation and exposes a definition for configuration, boot, and service
creation. Two adapters are registered: `opencode` (the default) and `pi`. An
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
`runtime: pi`; OpenCode otherwise. `loadConfig` reads it BEFORE the adapter
loads its own environment, so only the selected adapter's variables are parsed.
There is no per-request switching: one box, one harness, for the life of the
session (a restart or resume re-reads the selection).

## Ownership

| Location | Responsibility |
| --- | --- |
| `harness.ts` | Resolution and host-facing contracts |
| `assets.ts` | Harness maintenance contract |
| `control.ts`, `diagnostics.ts`, `queries.ts`, `proxy.ts` | Named host-facing operation contracts; no router dependencies |
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
| `pi/interactions.ts`, `pi/tools.ts`, `pi/model.ts`, `pi/relay.ts` | Permissions/questions, workspace tools, gateway model, control-plane callbacks |
| `../routes/` | Controllers, authentication, request parsing, HTTP status/headers, gzip and SSE delivery |

The host retains its entrypoint, monitor mode, Git/files/PTYs, authentication,
static previews, LLM/connector proxy, resource sampler, event sequencer,
managed-skill overlay (`managed-skills.ts`), attachment stripping
(`inline-attachments.ts`), the `on_boot` spawner and the CLI/daemon update
scheduler. These call service ports for harness behavior. They import no
adapter module; adapters import no other adapter (`harness-boundary.test.ts`).

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
same `/kortix/opencode/*` namespace and the same raw routes
(`/session`, `/session/:id/prompt_async`, `/session/:id/message`, `/config`,
`/agent`, `/provider`, `/permission/:id/reply`, …). One pi session is one Kortix
session: the root id is `ses_pi<sha256(sessionId)[:24]>`, deterministic, so a
restart resolves the same root and restores the transcript from
`$KORTIX_RUNTIME_STATE_DIR/pi/<session>.json`.

Config it reads (all set by apps/api for every session, harness-neutral values):
`KORTIX_OPENCODE_MODEL` (the resolved session model), `KORTIX_COMPILED_AGENT_CONFIG`
(agent prompt, model, permission policy), `KORTIX_AGENT_NAME`, `KORTIX_LLM_BASE_URL`
+ `KORTIX_TOKEN`, the image-baked catalog at `/opt/kortix/llm-catalog.json`.
pi-only: `KORTIX_PI_STATE_DIR`, `KORTIX_PI_MODEL_MODE=faux` +
`KORTIX_PI_FAUX_SCRIPT` (tests and benches: a scripted provider, no network).

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
| project | kortix.yaml `harnesses.pi.packages` → `KORTIX_PI_PACKAGES` | npm sources: built once per package list by the API (apps/api/src/pi-packages, on change-request merge) as a PRE-BUILT bundle — one self-contained ESM file per extension (deps inlined; pi's own modules read `globalThis.__kortixPiHost`) plus the package's own files — and the installed `node_modules` as a fallback. The daemon starts the download with the service (beside the repo clone), unpacks to `<KORTIX_PI_PACKAGES_DIR>/<digest>` (outside the repo) and imports each extension natively: no jiti, no install (`extensions/prebuilt.ts`). A package with no pre-built form, one whose file throws on import, or an entry with its own `extensions` filter loads from the fallback (`KORTIX_PI_PACKAGES_FALLBACK_URL`, fetched only then) through pi's loader |
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
`/kortix/opencode/messages/:id`, and persisted in the root's dump so `task_id`
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

`src/config-provider/` (the `git` / `prefer-s3` / `require-s3` project
acquisition coordinator, #7221) stays outside `src/harness/`. It depends only
on host modules (`config`, `git`, `logger`) and knows nothing about any
harness. Both `open-code/boot.ts` and `pi/boot.ts` call
`materializeProject(cfg, { bootMark, onSummary })` at the point where the cold
boot acquires the workspace. `boot-state.ts` (host) carries the outcome:
`configProvider` (reported in `/kortix/health` as `config_provider`) and
`deferredHistoryBackfill`.

## Native features remain available

The common interface is not a feature limit. Host controllers register every
existing route and invoke named resolved operations. The compatibility proxy
port preserves catch-all forwarding: for OpenCode that is a real upstream
process, for pi an in-process dispatcher — either way a native feature without a
common method still reaches the harness. OpenCode-specific configuration,
events and full lifecycle operations stay typed inside `open-code/`; pi's stay
inside `pi/`. No silent feature fallback or harness switching is added.

`createService` does not spawn a process or subscribe to events. Controllers
receive the resolved service through dependency injection; `/kortix/opencode/*`
remains a compatibility URL, not an implementation selector. The adapter cannot
register routes or receive a Hono context.

## Unchanged contracts

- Project folders, native config locations and configuration precedence.
- Environment variable names, defaults and loaded values (pi adds `KORTIX_PI_*`).
- Routes, response/event payloads, diagnostics and durable state filenames.
- Readiness gates, timeout policy and update ordering.
- SDK/UI behavior, Docker images and sandbox image selection.
