# Internal harness services

This boundary prepares the daemon for other harnesses. It does not add a second
harness or change the client protocol.

## Ownership

- `harness.ts`: lifecycle contract with no native protocol or config types.
- `open-code/service.ts`: composes one OpenCode supervisor into lifecycle,
  configuration, event, and native compatibility ports.
- `open-code/supervisor.ts`: existing process supervision, configuration
  assembly, model catalog, readiness, and reload implementation.
- `open-code/events.ts`: existing native SSE parsing, dispatch, and reconnect.

`main.ts` selects OpenCode explicitly, as before. It creates the service without
starting a process or event subscription. Boot, warm adoption, and monitor mode
keep their existing operation order. Shutdown depends only on the common stop
operation.

## Preserve native features

The common lifecycle is not a list of permitted product features. Concrete
services expose additional typed ports. OpenCode retains verified reload,
in-place config disposal, workspace gates, binary prefetch, diagnostics, and its
full native event stream. Another harness need not implement these operations.

Use `lifecycle` for common operations. Use `configuration` for OpenCode reload
and reconfiguration. Existing native routes and remaining native boot logic use
the complete `native` compatibility port. Do not silently replace an unsupported
feature with a weaker operation when adding another harness.

The lifecycle, configuration, and native ports reference the same supervisor.
Do not copy its methods into other objects: several use `this` to call sibling
methods. Event subscriptions receive the current config explicitly so warm
adoption does not retain the seed configuration.

## Compatibility and scope

Root `opencode.ts` and `opencode-events.ts` reexport the implementations. Existing
imports share the same module state; there is no duplicate supervisor or catalog
cache. Tests that inspect implementation source read the new owning files.

Project folders, configuration precedence, durable state filenames, API/SDK
contracts, native event payloads, route names, and Docker images are unchanged.
No registry, runtime selector, template system, capability-negotiation API, or
canonical response format is introduced.

Native HTTP routes, database projections, session pins, and OpenCode-specific
boot/reconciliation operations remain explicit follow-up seams. This extraction
does not claim that the entire daemon is harness-agnostic yet.
