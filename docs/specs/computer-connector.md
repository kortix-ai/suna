# Computer Connector — Agent Tunnel as a first-class Executor connector

**Status:** SPEC (decisions locked) · **Epic:** agent_tunnel → connector · **Branch:** `feat/computer-connector`
**Related:** `docs/specs/executor.md`, `apps/api/src/experimental/features.ts` (the standing TODO), KORTIX-206 (the `channel` precedent this mirrors)

---

## 1. Goal

Make every computer connected over the **Agent Computer Tunnel** reachable through the **Executor**, exactly the way Slack became reachable as a `channel` connector. Today the tunnel is its own account-scoped surface with its own routes, its own client (`TunnelClient` / the `agent-tunnel` skill-CLI), its own auth, and its own audit trail. The end state — already written down as the standing TODO in `experimental/features.ts` — is:

> expose [the tunnel] THROUGH the executor connectors system as an MCP-style connector, so it flows through the single `connectors`/`discover`/`describe`/`call` execution path like every other integration (one auth model, one audit trail, one policy engine).

Concretely, after this epic:

- A single **`computer`** connector shows up in `kortix executor connectors` / the `kortix-executor` MCP `connectors` tool / `@kortix/executor-sdk` whenever the account has at least one connected machine.
- That one connector fronts **all** the account's machines. The agent reaches a machine with `executor call computer fs.read { computer: "laptop", path: "…" }` (and `discover` / `describe` work over its actions) — **the same four verbs it uses for Slack, Gmail, Stripe, everything.**
- The Executor becomes the **central front door to every computer**: list (`list_computers`), discover, describe, call, share, policy — one surface, one thing to govern.
- The tunnel's existing security core (per-capability permissions, scoped grants, the human approval flow, the audit log, the WS relay) stays **100% intact underneath** — the Executor is an additional front door, not a replacement.

This is the direct analogue of the Slack work: a new Executor **provider type** whose catalog is fixed/native, whose "credential" is resolved server-side from an existing connection (here: the live tunnel), that **auto-materializes** when the thing is connected, and that renders with a "managed elsewhere" banner in the Connectors tab.

---

## 2. Current state (what exists today)

### 2.1 The tunnel subsystem (`apps/api/src/tunnel/`)
- **Relay:** `core/relay.ts` holds a singleton `TunnelRelay` (from the `agent-tunnel` package) with the live WS connections in-process. `relayRPC(tunnelId, method, params)` forwards an RPC to the connected local agent and awaits the signed response.
- **RPC route:** `POST /v1/tunnel/rpc/:tunnelId` (`routes/rpc.ts`) — body `{ method, params }`, returns `{ result }`. It: rate-limits → resolves the method's **capability** (`resolveCapability`, from `TunnelMethods`) → `checkPermission(tunnelId, capability, operation, params)` → on deny, inserts a `tunnel_permission_requests` row + notifies the user (SSE) + returns `403 { code: PERMISSION_DENIED, requestId }` → on allow, `relayRPC` + `writeAuditLog`. Errors map to 502 (offline) / 504 (timeout) / 500.
- **Auth model** (`routes/auth.ts`): `getTunnelReadContext` (apiKey **and** user/PAT — used by GET /connections, GET /:id, **POST /rpc**) vs `getTunnelOwnerContext` (= `requireUserCredential`, rejects apiKey — all management mutations). So the **sandbox apiKey can already RPC**; only humans/PATs manage.
- **Method set** (`packages/agent-tunnel/src/shared/types.ts`, `TunnelMethods`): the canonical source of truth — `fs.read|write|list|stat|delete` (`filesystem`), `shell.exec` (`shell`), ~45 `desktop.cua.*` (`desktop`), plus `tunnel.*` protocol notifications (capability `null`).
- **Permission model:** `tunnel_permissions` rows = `(tunnelId, capability, scope, status, expiresAt)`. Scope is capability-specific (`filesystem`: paths/operations/maxFileSize/excludePatterns; `shell`: commands/workingDir; `desktop`: features). Empty `{}` scope = allow-all within the capability. Granted at device-auth approve time and/or via the permission-request approval flow. `checkPermission` + `validateScope` enforce. **This is per-machine and stays authoritative.**
- **Scoping:** tunnels are **account-scoped** (`tunnel_connections.accountId`, optional `sandboxId` FK, **no projectId**). One laptop serves all the account's projects.
- **Lifecycle hooks:** tunnel **created** at `routes/device-auth.ts:300` (device-auth approve) and `routes/connections.ts:103` (POST /connections); **deleted** at `routes/connections.ts:283` (DELETE, cascades to permissions/audit/device-auth).
- **Consumers:** `kortix tunnel ls|show|rpc|rm` CLI (PAT auth); the in-sandbox `agent-tunnel` opencode skill-CLI (resolves first-online tunnel via GET /connections, calls POST /rpc with the sandbox apiKey); the npm daemon `npx @kortix/agent-tunnel connect` (device-auth → WS); the web **Customize → Computers** surface (gated by the `agent_tunnel` experimental flag).

### 2.2 The Executor & the `channel` precedent
The Executor is provider-pluggable. The `channel` provider (Slack) is the worked example for "a fixed native catalog + server-side credential + auto-materialize + managed-elsewhere UI", and **computer** follows the identical shape with three deltas:

| | `channel` (Slack) | `computer` (tunnel) — this spec |
|---|---|---|
| Catalog | fixed `http` bindings → slack.com/api | fixed **`tunnel`** bindings → relay RPC |
| Credential | install token via `loadSlackTokenForProject` (server-side) | **none** — the "credential" is the live WS relay; auth/scope is the tunnel permission layer |
| Execution | gateway → `executeCall` (HTTP) | gateway → **`executeComputerCall`** → shared tunnel RPC core (permission-check → relay → audit) |
| Cardinality | one `slack` connector per project | one `computer` connector per project, **fronting all the account's machines** (machine = an action arg) |
| Materialize trigger | Slack connect/disconnect | first machine connects / last machine removed |
| UI banner | "managed in Channels" | "managed in Computers" |

---

## 3. Design overview

Add a new Executor provider **`computer`**. When a project's account owns ≥1 tunnel, the Executor **synthesizes a single `computer` connector** — no `kortix.yaml` entry, no experimental opt-in; connecting a machine IS the registration, exactly like a Slack install. (Superseding the original D4 gating: the connector is a **regular** connector and no longer requires the per-project `agent_tunnel` flag — see §"D4".) That one connector exposes:

- **`list_computers`** — a meta action (handled server-side, no relay): returns the account's machines with `{ id, name, online, capabilities, platform }` so the agent can pick one.
- The **tunnel RPC method set** (`fs.*`, `shell.exec`, curated `desktop.cua.*` + a `desktop.cua.call` passthrough), each taking an extra **`computer`** selector arg (machine name or id; optional when exactly one machine is online → defaults to it).

When the agent calls an action, the gateway routes to a **shared tunnel RPC core** — the same `checkPermission → relayRPC → writeAuditLog` pipeline the dedicated `/rpc` route uses today (extracted so both callers share one code path). The fine-grained, **per-machine** tunnel permission/approval/audit model is **unchanged and authoritative**; the Executor adds discovery, member-sharing, a unified call interface, and an `executor_executions` audit row on top.

```
agent (sandbox)                          API process
  executor `call`  ──HTTP──▶  /executor/projects/:id/call
   computer.fs.read                          │
     {computer:"laptop", path}               ▼ gateway.handleCall  (provider === 'computer')
                                             │   access (connector sharing) + executor policy (default allow_all)
                                             ▼ deps.executeComputerCall({accountId, selector:"laptop", method:"fs.read", args})
                                             │   resolve selector → tunnelId  (scoped to accountId)
                                             ▼ tunnel/core: executeTunnelRpc(tunnelId, accountId, method, params)  ◀─ SHARED with POST /rpc/:id
                                                 checkPermission ─(deny)─▶ permission_request + {requestId}
                                                 (allow) ─▶ relayRPC ─WS─▶ local agent ─▶ result
                                                 writeAuditLog (Computers audit)
                                             ▼ executor_executions row (Executor audit)
```

---

## 4. Decisions (locked)

- **D1 — Cardinality: one `computer` connector, many machines.** A single connector per project fronts all the account's machines; the machine is an action argument (`computer`), with `list_computers` for discovery and default-to-sole-online for the common single-machine case. Rationale: machines are account-scoped while connectors are project-scoped, so one connector (exists iff the account has ≥1 machine) is far simpler than synthesizing/fanning N per-machine rows; you govern & share *one* thing ("central front door"); per-machine security is unchanged (the tunnel permission layer gates each machine individually). *(Chosen over per-machine connectors.)*
- **D2 — In-sandbox: a `computer` skill that drives the Executor (CLI/SDK/MCP).** Keep an ergonomic `computer` skill, but it calls the Executor (`@kortix/executor-sdk` / `kortix executor` / the MCP tools) instead of hitting `POST /rpc` directly — one auth path, one audit trail. Update `kortix-executor` SKILL.md to list the `computer` provider. *(Exact Slack precedent.)*
- **D3 — Desktop catalog: curated + passthrough.** Typed actions for `fs.*`, `shell.exec`, and high-value `desktop.cua.*` (click/type/press_key/screenshot/scroll/list_apps/launch_app/…), plus a generic `desktop.cua.call` passthrough for the ~45-method long tail. `describe` stays useful without hand-maintaining every schema.
- **D4 — Naming & gating (UPDATED).** Provider/enum value = **`computer`**; connector slug = `computer`; management CLI stays `kortix tunnel`. **Synth is NOT gated by the `agent_tunnel` experimental flag** — the `computer` connector is a *regular* connector that materializes whenever the account has a connected machine, exactly like the Slack channel connector. A machine can only exist when the platform tunnel service is on (`config.TUNNEL_ENABLED` gates the tunnel routes), so machine-presence already implies platform support. The `agent_tunnel` flag now gates **only** the dedicated Customize → Computers management UI (device-auth / per-machine permissions), not the connector. *(Original decision gated synth on the per-project flag; reversed so connecting a machine "just works" as a connector.)*

---

## 5. Data model

No new tables. Two additive changes:

1. **`executor_connector_provider` enum** (`packages/db/src/schema/kortix.ts`) — add `'computer'`. Drizzle-generated migration `…125_executor_computer_provider.sql` = `ALTER TYPE kortix.executor_connector_provider ADD VALUE 'computer'` (dev via ensureSchema push; prod via the migration at promote — same path as `channel`'s 124). **Local dev gotcha (from `channel`):** `dev-local.sh` sets `KORTIX_SKIP_ENSURE_SCHEMA=1`, so the local PG enum must be hand-bumped once: `ALTER TYPE kortix.executor_connector_provider ADD VALUE IF NOT EXISTS 'computer';`.

2. **`ActionBinding`** union (`apps/api/src/executor/types.ts`) — add `| { kind: 'tunnel'; method: string }`. The relay method name (`fs.read`, `desktop.cua.click`, …) rides in the binding; `list_computers` uses `{ kind: 'tunnel', method: 'list_computers' }` and is special-cased (meta, no relay).

The synthetic connector needs **no per-machine config** (it spans all machines): `config = { auth: { type:'none', … } }`, `baseUrl` null. The row's `accountId`/`projectId` are the project's; machine resolution happens at call time scoped to `accountId` (so the agent can only reach its own account's machines).

---

## 6. The computer catalog (`apps/api/src/executor/computers.ts`, NEW)

Mirrors `channels.ts`. Generated from the canonical `TunnelMethods` (imported from `agent-tunnel`), with hand-written schemas + risk for the typed ones. Because one connector spans machines of differing capabilities, the catalog exposes the **full** action set — per-machine capability is enforced at call time by the tunnel permission layer (a machine lacking `desktop` simply denies/410s a desktop call), so there is no per-machine catalog filtering to do.

- `computerCatalog() → NormalizedAction[]`:
  - `list_computers` — `risk: read`, no required args, binding `{ kind:'tunnel', method:'list_computers' }`.
  - Each tunnel method → an action with `binding = { kind:'tunnel', method }` and a `computer` selector added to its input schema (`{ type:'string', description:'Target machine — name or id from list_computers; optional if only one is online.' }`, not required).
  - Risk: reads = `fs.read/list/stat`, desktop getters/screenshot, `list_computers`; writes = `fs.write`, `shell.exec`, mouse/keyboard; destructive = `fs.delete`, `kill_app`.
  - Desktop: curated typed set + `desktop.cua.call` passthrough (args: `tool`, `args`) for the long tail (D3).
- `computerLabel()` = "Computers".

---

## 7. Execution path

### 7.1 Shared tunnel RPC core (refactor)
Extract the body of `routes/rpc.ts` into `apps/api/src/tunnel/core/rpc-core.ts`:
```ts
executeTunnelRpc(input: { tunnelId, accountId, method, params }):
  Promise<
    | { ok: true; result: unknown }
    | { ok: false; kind: 'permission_required'; requestId: string; message: string }
    | { ok: false; kind: 'error'; code: TunnelErrorCode; message: string; httpStatus: 400|404|500|502|504 }
  >
```
It does rate-limit → resolve capability → `checkPermission` → (deny) create `tunnel_permission_requests` + `notifyPermissionRequest` + return `permission_required` → (allow) `relayRPC` + `writeAuditLog`. **Both** `POST /v1/tunnel/rpc/:id` (translates the union → HTTP 200/403/5xx, **unchanged contract**) **and** the executor's `executeComputerCall` call this. Zero behavior change for the existing route (locked by its tests).

### 7.2 Gateway (`apps/api/src/executor/gateway.ts`)
- `GatewayConnector.provider` union += `'computer'`.
- New optional dep `GatewayDeps.executeComputerCall?(input: { accountId, selector: string|null, method, args }): Promise<ComputerCallOutcome>`.
- In `handleCall`, add a branch **before** the `executeCall` else (sibling to `pipedream`): when `connector.provider === 'computer'` and `binding.kind === 'tunnel'`:
  - `method === 'list_computers'` → return the machine list as `{ status:'ok', data }` (no relay).
  - else pull the `computer` selector out of `input.args`, call `deps.executeComputerCall({ accountId: input.accountId, selector, method: binding.method, args: rest })`, then map:
    - `ok` → `{ status:'ok', data:result, risk }` + audit ok.
    - `permission_required` → reuse the existing **`pending_approval`** CallResult: `{ status:'pending_approval', reason:'computer_permission_required: approve in Computers (request '+requestId+')' }`.
    - `no_machine` (selector unresolved / ambiguous / offline) → `{ status:'error', reason:'… use list_computers …' }`.
    - `error` → `{ status:'error', reason }` (offline/timeout surfaced clearly).

### 7.3 Selector resolution (`executeComputerCall`, in `db-deps.ts`)
- `list_computers`: query `tunnel_connections` where `accountId = input.accountId`; enrich with `tunnelRelay.isConnected(tunnelId)`; return `[{ id, name, online, capabilities, platform }]`.
- selector → tunnelId: match the account's tunnels by id, then by case-insensitive name; if omitted, pick the sole online machine; ambiguous/none → `no_machine`. **Always scoped to `input.accountId`** (the connector's account = the project's account = the tunnel's account), so cross-account access is impossible.
- then `executeTunnelRpc({ tunnelId, accountId, method, params: args })`.

### 7.4 Two-layer security (intentional, documented)
- **Executor layer:** connector sharing (`isSecretUsableBy` — which project members), per-agent grants (`agentMayUseConnector`), executor policy (left at default `allow_all` so it doesn't double-prompt). Govern the whole `computer` connector once.
- **Tunnel layer (authoritative, per-machine):** `tunnel_permissions` capability+scope + the permission-request approval UX + the tunnel audit log — unchanged. A freshly-connected machine with no grants still triggers the existing approval flow, now surfaced through the executor as `pending_approval`.
- **Audit:** both `tunnel_audit_logs` (Computers UI shows ALL relay RPC, however invoked) and `executor_executions` (Executor surface). Intentional dual-write.

---

## 8. Auto-materialization & reconcile

`apps/api/src/executor/computer-materialize.ts` (NEW), mirroring `channel-materialize.ts` but **one connector, not N**:
- `synthesizeComputerConnectors(projectId, declared) → ConnectorSpec[]`:
  1. If the `computer` slug is already declared → `[]` (never shadow).
  2. Resolve the project's `accountId`; if the account has **≥1** `tunnel_connections` row → return a single synthetic `computer` `ConnectorSpec` (`provider:'computer'`, `credentialMode:'shared'`, `auth:none`, slug `computer`, name "Computers"); else `[]`. **No `agent_tunnel` flag check** (updated D4) — machine presence is the only gate.
- Wire into `syncProjectConnectors` next to the channel synth (`sync.ts:120`): fold `computerSpecs` into `specs`; include `'computer'` in the **guarded-deletion** branch (`sync.ts:163`) so the connector is reaped when the last machine is removed but a transient git error never wipes it.
- `resolveCatalog` case `'computer'` (`sync.ts:290`-style): `{ actions: computerCatalog(), server: null }` — fixed, no network.
- `connectorConfig` case `'computer'` (`materialize.ts`): `{ auth: { type:'none', … } }`, baseUrl null.
- `db-deps.ts`: `baseUrlOf` → null; `authOf`/`hasAuth` → false; `connectorConnected` computer → "account has ≥1 tunnel"; `resolveCredential` computer → `null`; wire `executeComputerCall` into `makeDbGatewayDeps`.

**Reconcile.** Trivial vs the per-machine model — the connector exists iff the account has ≥1 machine:
- `reconcileComputerConnectors(accountId)`: list the account's projects, `void syncProjectConnectors(projectId, accountId)` for each (best-effort, never throws — same posture as `reconcileChannelConnectors`). Idempotent: re-syncing when machines come/go just confirms/creates/reaps the one connector.
- Fire from the lifecycle hooks: tunnel create (`device-auth.ts` approve, `connections.ts` POST) and delete (`connections.ts` DELETE).
- **Lazy fallback:** the synth also runs in every ordinary `syncProjectConnectors` (session start / periodic sweep / manual Sync), so the connector appears even if a fan-out is missed — eventual consistency, no orphan risk. (Machines coming/going *within* an existing connector need no resync at all — `list_computers` is always live.)

---

## 9. Web surface (dual-surface, mirrors Slack)

- **Customize → Computers** (existing, `agent_tunnel`-gated) stays the management home: connect via device-auth, grant/revoke per-machine permissions, view audit.
- **Customize → Connectors** now also lists the `computer` connector. `connectors-view.tsx`: add `computer → Monitor` icon + `providerLabel('computer') = 'Computers'`; render the credential/connect/remove controls as a **"managed in Computers"** `InfoBanner` (deep-link via `useCustomizeStore.setSection('computers')`); keep **sharing + the tool list**. `projects-client.ts`: `AdminConnector.provider` union += `'computer'`.

---

## 10. CLI / SDK / MCP / local

All **free** — `provider` is an opaque string downstream:
- `kortix executor connectors` lists the `computer` connector; `kortix executor call computer list_computers` then `... call computer fs.read '{"computer":"laptop","path":"…"}'` work locally and in-sandbox; `discover`/`describe` work over its actions.
- `@kortix/executor-sdk` sees it like any connector (this is also how we e2e-test, per the Slack precedent).
- `kortix-executor` MCP server (`apps/cli/src/executor/mcp.ts`) exposes it via the standard four tools.
- `kortix tunnel ls|show|rpc|rm` is unchanged (management/diagnostics).

---

## 11. File-by-file checklist

**NEW**
- `apps/api/src/executor/computers.ts` — catalog (`computerCatalog`, `computerLabel`) incl. `list_computers` + `computer` selector + curated desktop + passthrough.
- `apps/api/src/executor/computer-materialize.ts` — `synthesizeComputerConnectors` (single connector), `reconcileComputerConnectors(accountId)`.
- `apps/api/src/tunnel/core/rpc-core.ts` — extracted `executeTunnelRpc` (shared) + selector/`list_computers` helpers.
- `apps/api/src/__tests__/unit-executor-computers.test.ts` — catalog shape; synth (flag off → [], ≥1 tunnel → 1 spec, 0 tunnels → []); gateway call (mock `executeComputerCall`): ok / permission_required→pending_approval / no_machine / offline; selector resolution (id, name, default-sole-online, ambiguous, cross-account rejected).
- `docs/specs/computer-connector.md` — this spec.
- (D2) `packages/starter/templates/base/.kortix/opencode/skills/kortix-computer/SKILL.md` + repo-root `.kortix/...` copy.

**EDIT**
- `apps/api/src/executor/types.ts` — `ActionBinding` += `{ kind:'tunnel'; method }`.
- `apps/api/src/projects/connectors.ts` — `ConnectorProvider`/`PROVIDERS` += `'computer'`; `base` defaults; `parseProviderFields` case (computer = synth-only: reject explicit `[[connectors]]` declaration with a clear error, like channel rejects `auth`); auth guard (computer ⇒ none); toml round-trip + `manifestHashForConnector`.
- `packages/db/src/schema/kortix.ts` — enum += `'computer'`.
- `supabase/migrations/…125_executor_computer_provider.sql` — `ALTER TYPE … ADD VALUE 'computer'`.
- `apps/api/src/executor/sync.ts` — import + synth + `resolveCatalog` case + guarded-deletion `|| e.providerType === 'computer'` + `reconcileComputerConnectors`.
- `apps/api/src/executor/materialize.ts` — `connectorConfig` case `'computer'`.
- `apps/api/src/executor/db-deps.ts` — `baseUrlOf`/`authOf`/`connectorConnected`/`resolveCredential` computer branches + wire `executeComputerCall` (selector resolution + `executeTunnelRpc`).
- `apps/api/src/executor/gateway.ts` — provider union + `executeComputerCall` dep + `handleCall` branch (`list_computers` meta + relay + outcome mapping).
- `apps/api/src/tunnel/routes/rpc.ts` — delegate to `executeTunnelRpc`.
- `apps/api/src/tunnel/routes/connections.ts` + `device-auth.ts` — fire `reconcileComputerConnectors(accountId)` on create/delete.
- `apps/web/src/lib/projects-client.ts` — `AdminConnector.provider` += `'computer'`.
- `apps/web/src/components/projects/customize/sections/connectors-view.tsx` — icon + label + "managed in Computers" banner + suppress credential/remove for computer.
- `apps/api/src/experimental/features.ts` — resolve the standing TODO comment.
- `.kortix/.../kortix-executor/SKILL.md` ×2 + `apps/web/content/docs/concepts/connections.mdx` (+ a `computers.mdx`) + `manifest.mdx` (note: `computer` is synth-only, not declarable).
- (D2) `.kortix/opencode/skills/agent-tunnel/*` (×2) — route through the Executor; refresh SKILL.md.

---

## 12. Backwards compatibility (hard requirement)

100% additive, same discipline as the Slack epic:
- The dedicated `/v1/tunnel/*` routes, the WS relay + protocol, device-auth, the `agent-tunnel` npm daemon, `kortix tunnel`, and the Computers UI are **untouched** (the `/rpc` route only swaps its internals for the shared core — identical contract, locked by tests).
- Existing connected computers **auto-materialize** behind the one connector on the next sync (lifecycle fan-out + lazy sweep); nothing to migrate, no credential copy (there is no secret — the relay is the credential).
- The only behavior-changing phase is D2 (the in-sandbox skill cutover); it's isolated and gated, and even then the direct `/rpc` path keeps working.

---

## 13. Testing

- **Unit** (`bun test`, no network): catalog (selector present, risk, `tunnel` bindings, passthrough); `parseProviderFields` rejects explicit `computer` declaration; gateway `handleCall` for computer with a **mock `executeComputerCall`** (ok / permission_required→pending_approval / no_machine / offline); `synthesizeComputerConnectors` (flag gating, 0/1/N tunnels → 0/1/1 specs); selector resolution incl. cross-account rejection.
- **Shared-core regression:** existing `/rpc` route tests stay green after the extraction (contract unchanged).
- **e2e via the SDK** (Slack precedent): live local stack + a real connected machine — `connectors` shows `computer`; `call computer.list_computers` returns it; `call computer.fs.read` round-trips; a no-grant call → `pending_approval`; approve in Computers; retry succeeds; offline machine → clean error. Drive through `@kortix/executor-sdk`.
- **ke2e:** extend only if a route contract changes (it shouldn't — only enum values).

---

## 14. Phasing (PRs, each `preview`-labelled)

- **Phase A — API core:** enum + `ActionBinding` + `computers.ts` + `computer-materialize.ts` + `rpc-core.ts` refactor + sync/materialize/db-deps/gateway wiring + connectors.ts parse + unit tests. (Self-contained; computers materialize only with the flag + a tunnel.)
- **Phase B — Web dual-surface:** Connectors tab rendering + banner + types.
- **Phase C — In-sandbox cutover (D2):** `computer` skill → Executor + `kortix-executor` SKILL.md.
- **Phase D — Docs + e2e:** `computers.mdx`/connections/manifest + SDK e2e proof + memory update.

---

## 15. Risks / open questions

- **Multi-replica relay affinity** (pre-existing): the WS lives on whichever API replica the agent connected to; `relayRPC` only succeeds there. The executor path inherits this exactly as the `/rpc` route does today — **no new problem** (offline-on-wrong-replica surfaces as the normal 502/`error`).
- **Fan-out cost** on tunnel create/delete is now trivial (one connector, idempotent), backstopped by the lazy sweep.
- **Desktop catalog depth** — curated+passthrough now; expand later without breaking changes.
