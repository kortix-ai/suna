# Connector and connection cutover

**Status:** accepted for implementation on 2026-08-05.

## Problem

Kortix exposes two names for one product concept. The manifest and dashboard use
`connector`. The CLI, API namespace, runtime package, database schema, and MCP
server also expose the legacy `executor` name. Agents must learn overlapping
command trees and different paths for the same operation.

The CLI report also proves reliability defects in manifest mutations, help,
provider handling, output rendering, identifier resolution, and connector
provider creation.

## Canonical language

- A **connector** defines tools against an external system.
- A **connection** stores one usable authorization for a connector.
- A **connector call** invokes one connector tool.
- The server component is the **connector gateway**.
- The public command tree is `kortix connectors`.
- The published runtime client is `@kortix/sdk`.
- The MCP server is `kortix-connectors`.
- The in-sandbox command token is `KORTIX_CLI_TOKEN`.

Do not introduce `executor`, `integrator`, `integration`, or `profile` as a second product noun.

## Cutover boundaries

This is one coordinated cutover. It renames active code, API paths, package
names, runtime artifacts, environment flags, database objects, documentation,
skills, and tests.

The cutover does not keep active aliases for the removed command, API namespace,
npm package, MCP server, or environment variables. The user explicitly selected
one vocabulary everywhere. The root `@kortix/sdk` keeps deprecated exported
aliases only where its published public-surface contract requires them.

Historical database migration files remain immutable. A new forward migration
renames live database objects. The terminology audit excludes only migrations
that predate this cutover.

## CLI contract

`kortix connectors` is the only connector command tree.

```text
kortix connectors [ls]
kortix connectors ls [--session <session-id>] [--json]
kortix connectors show <connector>[.<action>] [--json]
kortix connectors discover <intent> [--json]
kortix connectors call <connector> <action> [json]
kortix connectors add <slug> --provider <provider> ... [--apply]
kortix connectors rm <slug> [--apply]
kortix connectors connect <slug> [--expires <minutes>]
kortix connectors credential <slug> [value|-]
kortix connectors rename <slug> <name>
kortix connectors mode <slug> shared
kortix connectors policy ...
kortix connectors sync
kortix connectors apps [query]
kortix connectors mcp
```

Every positional subcommand handles `--help` before validation or network I/O.
Machine output uses stdout only. Notices and failures use stderr.

`files compare` is removed. `files diff` remains.

Marketplace installation stays agent-driven. `marketplace install <item>` starts
the existing project install session and returns its `session_id`. Deterministic
lock/status/update commands remain removed because the platform no longer has a
deterministic install engine.

## Manifest mutation rules

- Local YAML mutations preserve every byte outside the targeted node.
- Local TOML mutations preserve every byte outside the targeted block or key.
- Remote mutations reload and retry once after a compare-and-swap conflict.
- A second conflict returns `409` with a direct retry instruction.
- Concurrent mutations never overwrite each other.

## API and data model

- Session-scoped gateway routes move to `/v1/connectors/*`.
- Project administration routes remain connector-named under the connector
  namespace during this cutover.
- Connector definitions use `connectors`.
- Concrete connections use `connector_connections`.
- Invocation audit rows use `connector_calls`.
- Credentials, OAuth state, policy, and attachment objects use connector or
  connection names according to ownership.

## Verification

Completion requires all of these gates:

1. Focused RED/GREEN regression tests for every report defect.
2. Full CLI unit and process suite.
3. Full connector SDK build, test, pack, install, and import smoke.
4. Full root SDK typecheck, test, and packed-install smoke.
5. Focused API and database integration suites.
6. A terminology scan with no active legacy names.
7. A real local stack test using a token row with `project_id`, `session_id`, and
   `agent_grant` populated.
8. A real cloud sandbox test using the token injected by session provisioning.
9. Every documented CLI command group has at least one positive black-box path.
10. Required negative and default/alternate paths pass.
11. The merged SHA is present in the completed Deploy Dev artifacts.
12. The same agent-token matrix passes against Dev.
