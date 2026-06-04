# Experimental features

We ship fast and we ship a lot. Some surfaces are real and usable but still
moving — they may change shape or break between versions. Rather than block them
behind a release or scatter one-off env flags, we expose them as **experimental
features** a project opts into. This is a *soft release*: we can push versions,
dogfood, and let users try a feature per project without treating it as
committed "prod" surface. When a feature is ready we graduate it (drop the flag,
default it on).

## Model

A feature has two gates:

- **available** — does the *platform* support it at all? Driven by operator env
  (e.g. the backend service is running). When unavailable, the per-project
  toggle is hidden and the surface stays dark no matter what a project chose.
- **enabled** — the *effective per-project* state: the project's explicit choice
  over the operator default. `enabled` always implies `available`.

Per-project state is **DB-only**, stored in `projects.metadata.experimental`:

```jsonc
// projects.metadata
{
  "experimental": { "apps": true, "agent_tunnel": false }
}
```

It is **never** in `kortix.toml` — this is platform/account wiring, not project
source. (Legacy: `apps` used to live at `metadata.apps_enabled`; the registry
still reads it for back-compat and migrates it on the next write.)

## Single source of truth

`apps/api/src/experimental/features.ts` is the registry. Each entry declares
`key`, `name`, `description`, `stability`, `available()`, `platformDefault()`.
Everything else derives from it:

- `resolveExperimentalFeature(metadata, key)` — effective on/off (used by API
  gates).
- `buildExperimentalCatalog(metadata)` — the self-describing list the web UI
  renders straight from `serializeProject` (`project.experimental_features`).
- `applyExperimentalOverride(metadata, key, enabled)` — the write helper behind
  `PATCH /v1/projects/:id/experimental`.

`serializeProject` threads both `experimental` (effective map) and
`experimental_features` (catalog) onto every project payload, so the API gates
and the UI light up from the same value.

### Adding a feature

1. Append an entry to `FEATURES` in `experimental/features.ts`.
2. Gate the API surface on `resolveExperimentalFeature(metadata, key)`.
3. Gate the UI surface on `project.experimental[key]`.

The Customize → Settings → Experimental card renders from the catalog, so the
toggle appears automatically.

## Current features

| key | name | available | default | surface |
| --- | --- | --- | --- | --- |
| `apps` | Apps | always | `KORTIX_APPS_EXPERIMENTAL` | `/apps` routes + sweep + sidebar Apps overlay |
| `agent_tunnel` | Agent Computer Tunnel | `TUNNEL_ENABLED` | off (explicit opt-in) | Customize → Computers (the tunnel manager) |

Candidates to register next: Company Brain, Marketplace.

## UI

- **Toggle:** Customize → Settings → Experimental. One row per available
  feature, with a stability badge and a "still moving — may change or break"
  disclaimer. Writes via `PATCH /v1/projects/:id/experimental`.
- **Surfaces:** each feature's surface self-gates on its effective flag so it
  appears/disappears with the toggle.

---

## Agent Computer Tunnel — current state & future direction

The tunnel is **already fully implemented**: `packages/agent-tunnel` (server
relay, local agent with filesystem/shell/desktop capabilities, client SDK,
JSON-RPC + HMAC), the API sub-service at `apps/api/src/tunnel` (connections,
permissions, permission-requests, RPC relay, audit, device-auth, WebSocket),
the DB schema (`tunnel_*` tables), and the web UI (`components/tunnel/*`). It is
mounted at `/v1/tunnel` and gated platform-wide by `TUNNEL_ENABLED`.

What this change adds: the per-project **experimental gate** + a discoverable
surface (Customize → Computers) so it can be soft-released and dogfooded per
project instead of being reachable only via a hidden legacy tab.

### TODO — fold the tunnel into the executor connectors system

Today the tunnel is its own account-scoped surface with its own auth, audit, and
permission model. The intended end state is to expose it **through the executor
connectors system** as an MCP-style connector, so it flows through the single
`connectors` / `discover` / `describe` / `call` execution path like every other
integration:

- One auth model (executor credentials), one audit trail
  (`executor_executions`), one policy engine (`[[connectors.policies]]`,
  risk-derived approval) instead of the bespoke tunnel permission tables.
- The desktop/filesystem/shell capabilities become connector *actions*
  (`binding: { kind: 'mcp', tool }`), discoverable by intent like any tool.
- Agents reach a local machine with zero new surface area — it's just another
  connector in the catalog.

Sketch: register the per-tunnel relay as an MCP endpoint the executor can
`listMcpTools` against; map each `desktop.*` / `fs.*` / `shell.*` RPC to a
normalized action; resolve the tunnel setup token as an executor credential.
The capability→permission grant maps onto connector sharing + policy.

Until that lands, the experimental flag gates the dedicated surface above.
