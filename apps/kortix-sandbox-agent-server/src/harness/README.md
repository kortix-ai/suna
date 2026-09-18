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

Not supported by pi today (answered honestly, never silently): session rewind
(`/session/:id/revert`, 501 `feature_not_supported`), slash commands
(`/session/:id/command`), summarize/compaction, subagent sessions, MCP/connector
tools, todo tools, warm-seed capture. `/kortix/health` reports `harness: 'pi'`
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
