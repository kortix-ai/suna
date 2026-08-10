# Computer Tunnel connector profiles

**Status:** Implemented specification

**Related:** `docs/specs/connector.md`, `apps/web/content/docs/connect/computers.mdx`

## Goal

Treat Computer Tunnel as one regular connector provider. A connector profile selects
one or more machines that the project account or profile creator owns. Connector
grants, tool policies, audit, and session exposure apply to the profile.

The connector profile is the only fleet-management surface. It pairs machines,
shows online state, selects profile membership, and manages tunnel capability
permissions. Pairing does not grant project access.

## Product contract

- Computer Tunnel appears in the normal connector catalog.
- A user creates a connector profile and selects one or more paired machines.
- One machine can belong to multiple connector profiles.
- A project can contain multiple profiles with different or overlapping sets.
- The connector config stores selected machine ids in `tunnel_ids`.
- The connector config stores verified machine owner ids in `tunnel_account_ids`.
- Every profile exposes `list_computers`.
- `list_computers` returns only machines assigned to that profile.
- Every machine action accepts an optional `computer` name or id selector.
- The selector can resolve only inside the profile's assigned set.
- A selector is optional when exactly one assigned machine is online.
- Each profile has normal Accounts, Tools, and Settings tabs.
- The Accounts tab edits the profile's assigned machine set.
- The Tools tab edits the profile's independent tool policy.
- The Settings tab edits normal connector grants and settings.
- Computer operations appear under Connectors in the account audit log.

## Identity and storage

Computer Tunnel profiles are project-scoped connector rows with these fixed values:

```text
provider               computer
credential_mode        shared
authorization_strategy project
auth.type               none
config.computer_profile true
config.tunnel_ids       [<tunnel uuid>, ...]
config.tunnel_account_ids [<owner account uuid>, ...]
```

The user chooses the connector name and slug. The first suggested slug is
`computers`. Additional profiles use another available slug. Machine ids are
stable tunnel UUIDs. Renaming a paired machine does not change a profile.

Profiles do not live in `kortix.yaml`. Tunnel ids are account control-plane
identities. The normal connector API creates, updates, renames, and deletes the
DB-backed profiles.

The API validates every selected machine:

1. The profile contains between 1 and 100 unique UUIDs.
2. Every UUID belongs to the project account or the profile creator's personal account.
3. Every selected machine completed at least one tunnel connection.

The API resolves machine ownership during profile creation. It stores the
verified owner account ids in `tunnel_account_ids`. Runtime calls use both
`tunnel_ids` and `tunnel_account_ids`. A client cannot grant an arbitrary owner
account by adding it to the request.

An empty set fails closed. Pairing a machine creates only a fleet record. It
does not create a connector profile or grant access to a project.

## Catalog

Every Computer Tunnel profile receives the native catalog from
`apps/api/src/connectors/computers.ts`:

- `list_computers`
- `fs.read`, `fs.write`, `fs.list`, `fs.stat`, `fs.delete`
- `shell.exec`
- curated `desktop.cua.*` operations
- `desktop.cua.call` for the computer-use long tail

Each machine action uses `{ kind: 'tunnel', method }`. The action schema includes
the optional `computer` selector plus the operation inputs. `list_computers` has
no selector because it lists the profile's complete allowed set.

Examples:

```bash
kortix connectors call studio-computers.list_computers '{}'

kortix connectors call studio-computers.fs.read \
  '{"computer":"MacBook-Pro-9.local","path":"/etc/hosts"}'
```

## Execution

The gateway loads `config.tunnel_ids` and `config.tunnel_account_ids` from the
materialized connector. It passes both server-side allowlists and the optional
selector to `executeComputerCall`.

```text
connector call
  -> connector grant
  -> connector tool policy
  -> profile machine allowlist
  -> account ownership check
  -> tunnel capability and scope check
  -> WebSocket relay
  -> tunnel audit and connector audit
```

`listAccountComputers` applies the machine and verified owner allowlists in the
same database query. `list_computers` returns that filtered result. Other actions
resolve their selector only against that result. An unassigned, deleted, or
unverified cross-account machine returns `no_machine` before tunnel permission
evaluation.

The direct `POST /v1/tunnel/rpc/:tunnelId` route and connector execution share
`executeTunnelRpc`. Rate limits, tunnel permissions, relay errors, and tunnel
audit behavior stay identical.

Project PATs, sandbox keys, and service-account credentials cannot call the raw
tunnel connection or RPC routes. They must use a Computer Tunnel connector profile.
Interactive users, account PATs, and account API keys retain direct account-level
fleet access. Organization owners and admins can use the organization fleet.
Regular organization members can use and manage only personal machines through
raw tunnel routes; assigned connector profiles remain available through normal
connector grants and tool policy.

## Permission model

Two permission layers remain intentional:

1. Connector grants and connector tool policies decide who can use the profile
   and which tools can run.
2. Tunnel permissions decide which filesystem paths, shell commands, and
   desktop features each selected machine exposes.

The connector profile authorizes membership in a machine set. Tunnel
permissions remain specific to each machine.

The local agent enforces each permission again. Server scope data cannot widen
the local `allowedPaths`, `blockedPaths`, command, timeout, file-size, or desktop
feature ceilings. Unknown methods, capabilities, fields, malformed scopes, and
empty restriction arrays fail closed. An empty scope object is the only explicit
unrestricted grant.

Remote API URLs require HTTPS/WSS. Plain HTTP/WS is accepted only for loopback
development. Browser-origin WebSocket upgrades are rejected because the tunnel
agent protocol is CLI-only.

Cross-replica RPC queue rows are ephemeral transport data. They can briefly
contain raw parameters or results while a request moves between API replicas.
The requester deletes terminal rows after consumption. The relay deletes all
rows after their short `expires_at` window. Audit rows store only structural
request summaries, result byte counts, and hashed error messages.

## Fleet lifecycle

The Computer Tunnel profile manages account-level tunnel records. These events
reconcile the connector materializer without changing profile membership:

- the first authenticated WebSocket connection;
- tunnel rename or capability update;
- tunnel deletion;
- device approval as a repair path;
- normal project connector synchronization.

Deleting a paired machine removes it from the fleet. A stale profile reference
then fails closed because account ownership resolution cannot find the machine.
The user can update or delete that profile through the connector API.

## Audit model

Central audit events use:

```text
source        connector
action        connector.computer.<operation>
resource_type computer_tunnel
resource_id   <tunnel-id>
```

The account Audit page uses the regular Connectors filter. The UI does not
expose a separate COMPUTER category. Historical `computer.*` events remain
included by the connector audit reconciliation path.

## Compatibility and migration

The original aggregate `computer` row can omit `tunnel_ids`. A null allowlist is
accepted only for that compatibility row and means all account machines. The API
hides this row from connector administration and unbound principals. Only a
session with an exact durable binding to the row can discover or call it. This
keeps existing sessions operational without granting legacy aggregate access to
new sessions or project-level callers.

PR #6287 briefly created one `computer-<uuid>` profile per machine. The next
connector sync folds those generated rows into one `computer` profile with a
`tunnel_ids` array. Profiles marked `computer_profile: true` are explicit and
remain independent.

Legacy `config.tunnel_id` values normalize to a one-element allowlist. New and
updated profiles always store `config.tunnel_ids`.

## Verification requirements

1. One profile can contain two assigned machines.
2. `list_computers` returns exactly those two machines.
3. A call can target either assigned machine.
4. An unassigned machine id fails closed.
5. A cross-account machine id fails closed.
6. Two profiles can contain overlapping machine sets.
7. Policies and grants remain independent per profile.
8. Updating assignments preserves the profile's policies and sensitive state.
9. Pairing a machine does not create a connector profile.
10. Audit actions use `connector.computer.*` under the Connectors category.
11. The Accounts tab can create and update one-machine and multi-machine sets.
12. The deployed UI shows Computer Tunnel in the normal connector catalog.
13. A project admin can grant a computer from their personal account to an organization project.
14. A machine owned by any other account fails closed.
