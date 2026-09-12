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
| `open-code/service.ts` | Composition over one supervisor; native typed ports |
| `open-code/boot.ts` | Native cold boot, warm seed/adoption, first turn, reconciliation and relays |
| `open-code/http.ts`, `open-code/routes/` | Full existing compatibility HTTP surface and forwarding |
| `open-code/events.ts`, `open-code/event-bus.ts` | Native event reading, session identity and recovery instructions |
| `open-code/config.ts`, `open-code/paths.ts` | Native environment, authored config discovery and paths |
| `open-code/assets.ts` | Native binary/plugin updates and skill placement |
| `open-code/background.ts`, `open-code/resource-diagnostics.ts` | Native offload, turn guard and diagnostic projection |
| Other `open-code/` modules | Native database, projections, pins, attachments, audit and recovery |

The host retains its entrypoint, monitor mode, Git/files/PTYs, authentication,
static previews, LLM/connector proxy, resource sampler, event sequencer, and
CLI/daemon update scheduler. These call service ports for harness behavior.
They do not import OpenCode modules or unwrap a native supervisor.

There are no root `opencode.ts` or `opencode-events.ts` compatibility reexports.
Native tests import the implementation that owns the behavior. A package-level
architecture test rejects concrete adapter imports from host production code.

## Native features remain available

The common interface is not a feature limit. The HTTP port mounts every existing
native route and preserves catch-all forwarding. OpenCode-specific configuration,
events and full supervisor operations remain typed inside the adapter. A future
adapter can expose its own features without implementing weaker substitutes for
OpenCode operations. No silent feature fallback or harness switching is added.

`createService` does not spawn a process or subscribe to events. The lifecycle,
configuration and internal supervisor refer to the same object. Methods that use
`this` keep their owner. Warm adoption reuses that object and passes refreshed
configuration to event subscriptions and HTTP rebuilds.

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
