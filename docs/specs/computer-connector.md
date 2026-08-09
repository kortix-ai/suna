# Computer connector profiles

**Status:** Implemented specification

**Related:** `docs/specs/connector.md`, `apps/web/content/docs/connect/computers.mdx`

## Goal

Represent each connected machine as one standalone Connector profile.

The profile is the machine selector. Connector grants and tool policies can
therefore allow one machine and block another. Tool calls never receive an
account-wide machine selector.

The dedicated Computers page remains the account-level lifecycle surface. It
pairs machines, shows online state, and manages tunnel capability grants.

## Product contract

- One heartbeat-bearing tunnel creates one `computer` connector in each project
  owned by the same account.
- The connector name is the tunnel connection name.
- The connector slug is `computer-<full-tunnel-uuid>`.
- The connector config stores the immutable `tunnel_id`.
- The connector catalog contains the machine operations only.
- The catalog does not contain `list_computers`.
- Tool input schemas do not contain a `computer` field.
- The Connectors page shows each machine as a normal connector card.
- Each machine profile has an Accounts tab that identifies its bound machine.
- Each machine profile has an independent Tools policy tab.
- The Computers page remains the fleet-management page.
- Computer operations appear under Connectors in the account audit log.

## Why the connector is per machine

The old aggregate design created one `computer` connector that fronted every
machine in the account. Each tool accepted a machine name or id. That design
created three security problems:

1. A connector grant implicitly granted discovery of every machine.
2. One connector policy applied to every machine.
3. A mutable name or caller-supplied id selected the execution target.

The per-machine design makes the connector identity the authorization target.
The gateway reads the tunnel id from server-side connector config. The caller
cannot redirect a call to a different machine.

## Identity and materialization

`synthesizeComputerConnectors(projectId, declared)` queries the project's
account for `tunnel_connections` rows with `last_heartbeat_at IS NOT NULL`.
It emits one synthetic `ConnectorSpec` per row.

The synthetic spec has these fixed values:

```text
slug                   computer-<full-tunnel-uuid>
name                   <tunnel connection name>
provider               computer
credential_mode        shared
authorization_strategy project
auth.type               none
tunnel_id               <full-tunnel-uuid>
```

The full UUID prevents collisions. The tunnel id does not change when the user
renames the machine. The rename updates only the connector display name.

A pairing row without a heartbeat does not create a connector. A machine that
connected once remains materialized while offline. Deleting the tunnel removes
its connector unless a durable session binding still references the row. A
referenced row becomes disabled until that binding ages out.

## Catalog

Every machine profile receives the same native catalog from
`apps/api/src/connectors/computers.ts`:

- `fs.read`, `fs.write`, `fs.list`, `fs.stat`, `fs.delete`
- `shell.exec`
- curated `desktop.cua.*` operations
- `desktop.cua.call` for the computer-use long tail

Each action uses `{ kind: 'tunnel', method }`. Its input schema contains only
the operation inputs. The connector slug selects the machine.

Example:

```bash
kortix connectors call computer-11111111-1111-4111-8111-111111111111 \
  fs.read '{"path":"/etc/hosts"}'
```

## Execution

The gateway resolves the materialized connector and passes its `tunnel_id` to
`executeComputerCall`.

```text
connector call
  -> connector grant
  -> connector tool policy
  -> bound tunnel ownership check
  -> tunnel capability and scope check
  -> WebSocket relay
  -> tunnel audit and connector audit
```

`executeComputerCall` verifies both `account_id` and `tunnel_id` against
`tunnel_connections` before relay. A deleted tunnel or a tunnel owned by a
different account returns `no_machine`. The gateway never accepts a selector
for a per-machine connector.

The direct `POST /v1/tunnel/rpc/:tunnelId` route and Connector execution share
`executeTunnelRpc`. This keeps rate limits, tunnel permissions, relay errors,
and tunnel audit behavior identical.

## Permission model

Two permission layers remain intentional:

1. Connector grants and connector tool policies decide which project members,
   agents, and sessions can use this machine profile and which tools can run.
2. Tunnel permissions decide which filesystem paths, shell commands, and
   desktop features the machine exposes.

Both layers are per machine because both resolve through the bound tunnel id.

## Lifecycle reconciliation

`reconcileComputerConnectors(accountId)` synchronizes all projects for the
account. These lifecycle events call it:

- the first authenticated WebSocket connection;
- tunnel rename or capability update;
- tunnel deletion;
- device approval as a repair path;
- normal project connector synchronization.

The first WebSocket connection writes `last_heartbeat_at` before reconciliation.
The machine profile therefore appears only after a real agent connects.

## Audit model

New central audit events use:

```text
source        connector
action        connector.computer.<operation>
resource_type computer_tunnel
resource_id   <tunnel-id>
```

The account Audit page has one Connectors quick filter. The API includes legacy
`computer.*` events when that filter is active. The UI does not expose a second
Computer quick-filter category.

The tunnel audit log remains the machine-level technical record. Connector
calls also write the standard Connector call record.

## Compatibility and migration

The retired aggregate connector used slug `computer`, exposed
`list_computers`, and accepted `args.computer`.

Compatibility is limited to durable bindings that already reference that
aggregate row:

- gateway execution recognizes only the exact legacy slug `computer`;
- legacy calls can still use `list_computers` and `args.computer`;
- new per-machine catalogs never expose those inputs;
- user-facing connector lists hide the aggregate row after at least one
  per-machine profile exists;
- historical `computer.*` audit events remain visible under Connectors.

No database migration rewrites session bindings. Reconciliation creates the new
profiles. The legacy row can age out without breaking an active durable session.

## Verification requirements

1. Two tunnels create two connector rows with different `tunnel_id` values.
2. Neither catalog contains `list_computers` or a `computer` input field.
3. A policy change on one profile does not change the other profile.
4. A call through one profile reaches only its bound tunnel.
5. A cross-account or deleted `tunnel_id` fails closed.
6. A rename updates the connector name without changing its slug.
7. A delete removes or disables only the deleted machine profile.
8. A never-connected pairing row creates no profile.
9. The Audit page groups new and legacy computer events under Connectors.
10. The deployed web UI shows each machine as its own connector profile.
