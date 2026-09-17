# Internal harness boundary

`harness.ts` is the only host module that imports a concrete adapter. It resolves
the implementation and exposes a definition for configuration, boot, and service
creation. OpenCode remains the default. Unknown explicit IDs fail; no environment
selector, project setting, or UI behavior is added.

```ts
const selected = resolveHarness(cfg)
const runtime = selected.createService(cfg, projectEnv)
await runtime.lifecycle.start()
```

## Ownership

| Location | Responsibility |
| --- | --- |
| `harness.ts` | Resolution and host-facing contracts |
| `assets.ts` | Harness maintenance contract |
| `open-code/service.ts` | Composition over one lifecycle; native typed ports |
| `open-code/boot.ts` | Native cold boot, warm seed/adoption, first turn, reconciliation and relays |
| `../routes/` | Controllers, authentication, request parsing, HTTP status/headers, gzip and SSE delivery |
| `control.ts`, `diagnostics.ts`, `queries.ts`, `proxy.ts` | Named host-facing operation contracts; no router dependencies |
| `open-code/control.ts`, `open-code/diagnostics.ts`, `open-code/queries.ts` | Native execution, configuration, state queries, diagnostics and attachments |
| `open-code/proxy.ts` | Native readiness, upstream client, timeout classification and payload processing |
| `open-code/events.ts`, `open-code/event-bus.ts` | Native event reading, session identity and recovery instructions |
| `open-code/config.ts`, `open-code/paths.ts` | Native environment, authored config discovery and paths |
| `open-code/assets.ts` | Native binary/plugin updates and skill placement |
| `open-code/background.ts`, `open-code/resource-diagnostics.ts`, `open-code/quick-queue-interrupt.ts` | Native offload, turn guard, tool-boundary queue interrupt and diagnostic projection |
| Other `open-code/` modules | Native database, projections, pins, attachments, audit and recovery |

The host retains its entrypoint, monitor mode, Git/files/PTYs, authentication,
static previews, LLM/connector proxy, resource sampler, event sequencer, and
CLI/daemon update scheduler. These call service ports for harness behavior.
They do not import OpenCode modules or unwrap a native lifecycle.

## Config provider is a host service, not harness logic

`src/config-provider/` (the `git` / `prefer-s3` / `require-s3` project
acquisition coordinator, #7221) stays outside `src/harness/`. It depends only
on host modules (`config`, `git`, `logger`) and knows nothing about any
harness. The relationship is one-directional:

- `open-code/boot.ts` calls `materializeProject(cfg, { bootMark, onSummary })`
  at the point where the cold boot acquires the workspace, exactly as
  `main.ts` did before the boundary existed. The harness consumes the
  service; the service never imports a harness module.
- `boot-state.ts` (host) carries the outcome: `configProvider` (the
  `ConfigProviderSummary` reported in `/kortix/health` as `config_provider`)
  and `deferredHistoryBackfill` (a prepared-S3 start defers the history
  backfill until the runtime is actually ready). The OpenCode boot reads and
  runs them; a future adapter does the same through the shared boot state.
- Its tests (`config-provider.test.ts`) import the provider and `git`
  directly. No harness fixture is involved.

A change to the acquisition protocol (descriptor source, pack format, retry
policy) lands in `src/config-provider/` and reaches every harness through
this one call site.

There are no root `opencode.ts` or `opencode-events.ts` compatibility reexports.
Native tests import the implementation that owns the behavior. Package-level architecture tests reject concrete adapter imports from host
production code and HTTP framework/controller imports from harness modules.

## Native features remain available

The common interface is not a feature limit. Host controllers register every
existing route and invoke named resolved operations. The compatibility proxy port
preserves catch-all forwarding, including native features without a common method.
OpenCode-specific configuration,
events and full lifecycle operations remain typed inside the adapter. A future
adapter can expose its own features without implementing weaker substitutes for
OpenCode operations. No silent feature fallback or harness switching is added.

`createService` does not spawn a process or subscribe to events. The lifecycle,
configuration and internal lifecycle refer to the same object. Methods that use
`this` keep their owner. Warm adoption reuses that object and passes refreshed
configuration to event subscriptions and controller rebuilds.

Controllers receive the resolved service through dependency injection. They never
select OpenCode or access its lifecycle. `routes/harness-control.ts` binds current
configuration to control/query operations and registers the existing URLs.
`/kortix/opencode/*` remains a compatibility URL, not an implementation selector.

The adapter cannot register routes or receive a Hono context. Native services
return data, operation outcomes, attachment bytes, or event subscriptions. The
upstream compatibility client returns a transport result; the controller handles
HTTP response construction and SSE keepalives. Existing native payload fields
remain intact. This refactor does not introduce a canonical response protocol.

## Unchanged contracts

- Project folders, native config locations and configuration precedence.
- Environment variable names, defaults and loaded values.
- Routes, response/event payloads, diagnostics and durable state filenames.
- Readiness gates, timeout policy, native feature coverage and update ordering.
- SDK/UI behavior, Docker images and sandbox image selection.

The event sequencer owns only ordering and replay. Native event interpretation
and resync URLs live in the adapter. The shared resource sampler uses generic
process fields; the adapter produces the existing diagnostic JSON and messages.

This is code organization for future integrations. It does not implement a second
harness, a new client protocol, capability negotiation, or project migration.
