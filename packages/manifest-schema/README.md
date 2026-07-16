# `@kortix/manifest-schema`

Canonical `kortix.yaml`/`kortix.toml` schema + validator. One source of truth,
exercised by:

1. `kortix ship` (CLI) — pre-flight validation before push.
2. The backend CR-merge gate — backstop so manifests pushed without the CLI
   (raw git push, dashboard edit) still can't take a project down.
3. `kortix validate` (CLI) — explicit subcommand that runs the validator and
   prints a report.

`validateManifest(input, format)` is pure: no I/O, no DB calls, just
`(rawText | object) → ManifestValidationResult` (`{ valid, parsed, issues }`,
each issue a `{ path, message, severity, line?, column? }`). See
`packages/manifest-schema/src/index.ts`.

This file documents `kortix_version: 3`, the current schema. Earlier versions
are summarized in [Version dispatch](#version-dispatch) below.

## The v3 shape

```yaml
kortix_version: 3

default_agent: kortix

runtimes:
  opencode:
    harness: opencode
    config_dir: .kortix/opencode
  claude:
    harness: claude
    config_dir: .claude

agents:
  kortix:
    runtime: opencode
    agent: kortix
    connectors: all
    secrets: all
    kortix_cli: all
    skills: all

  memory-reflector:
    runtime: opencode
    agent: memory-reflector
    kortix_cli: [project.cr.open]
```

**The config-ownership law:** `kortix.yaml` registers logical agents and
selects a native runtime. It does not translate prompts, models, providers,
hooks, or native agent definitions — the harness's config dir owns behavior.
(`packages/manifest-schema/src/index.v3.ts`'s module doc: "Kortix owns
registration, routing, and governance. Native harness config owns prompts,
models, providers, hooks, modes, and permissions. The compiler consumes this
shape to produce a launch plan; it never translates one harness's behavior
format into another.")

### `runtimes` — launch profiles

A map of runtime-profile name → `{ harness, config_dir? }`. Each entry is a
**launch profile**, not translated configuration: it tells the orchestrator
which official ACP harness to boot and which repo-relative directory holds
that harness's own native config. `harness` must be one of the values in
[`V3_HARNESS_VALUES`](#version-dispatch) — currently `claude`, `codex`,
`opencode`, `pi` (`packages/manifest-schema/src/index.v3.ts`
`validateRuntimesV3`). `config_dir`, when set, must be a non-empty
repo-relative path with no leading `/` and no `..` segment
(`validateRelativePath` in the same file). No other keys are permitted on a
runtime block — anything else is a hard error pointing at the harness config
dir instead (`validateRuntimesV3`'s "Unknown runtime field" check). At least
one runtime profile is required.

### `agents` — governance + routing ONLY

A map of logical-agent name → block. Each block declares:

| Key | Notes |
| --- | --- |
| `runtime` | **Required.** Name of a key in the top-level `runtimes` map. |
| `agent` | Optional harness-native agent/profile identifier (when provided, must be non-empty). |
| `enabled` | Optional boolean; default `true` when omitted. |
| `connectors` / `secrets` / `skills` / `kortix_cli` | Grant sets (see below). |
| `workspace` | `"runtime"` \| `"read"` \| `"branch"`. |

No other keys are legal — a behavioral field (model, mode, prompt, temperature,
etc.) authored here is a hard error naming the harness config dir as the
correct home (`validateAgentsV3`'s "Unknown logical-agent field" check,
`packages/manifest-schema/src/index.v3.ts`). At least one logical agent is
required, and `default_agent` must name a declared, enabled agent
(`validateManifestCrossRefsV3`). Every `agents.<name>.runtime` must resolve to
a declared `runtimes` key, or it's a cross-reference error.

### Grant sets

`connectors`, `secrets`, `skills`, and `kortix_cli` share one shape:
an array of names, the string `"all"`, or the string `"none"`. **Omitted
resolves to deny (`"none"`), not `"all"`** — v3 keeps v2's deny-by-default
posture (`validateGrantList`, called with `version: 3` from `validateAgentsV3`).
`kortix_cli` additionally checks each entry against the grantable project-scoped
IAM action catalog (`GRANTABLE_KORTIX_CLI_ACTIONS` in
`packages/manifest-schema/src/constants.ts`); `connectors`/`secrets`/`skills`
accept any non-empty string (project-defined names, no fixed catalog).

### Workspace modes

`workspace` accepts `"runtime"`, `"read"`, or `"branch"`
(`WORKSPACE_MODES_V2` in `packages/manifest-schema/src/constants.ts` — the
enum is shared with v2, hence the `V2` suffix in its name).

### `enabled`

A declared agent with `enabled: false` cannot be `default_agent`
(`validateManifestCrossRefsV3`) and is tracked as disabled for cross-reference
checks (`AgentsV3Scan.disabledNames`).

### The native `agent:` id

`agents.<name>.agent` is the optional harness-native identifier — e.g. which
`.claude/agents/<id>.md` or `.kortix/opencode/agents/<id>.md` the runtime
should boot for this logical agent. When provided it must be a non-empty
string; there is no further validation here because its legality is entirely
the harness's own concern.

## Version dispatch

| `kortix_version` | Format | Shape |
| --- | --- | --- |
| 1 | TOML or YAML | `[[agents]]` array overlay; `[[channels]]` allowed. |
| 2 | YAML only | `agents:` name→block map, governance only; `[[channels]]` removed; deny-by-default grant sets. |
| 3 | YAML only | `runtimes:` map (launch profiles) + `agents:` map (routing + governance only); no top-level `runtime`/`opencode` keys (see below). |

(`packages/manifest-schema/src/index.ts`'s `KNOWN_SCHEMA_VERSION = 3` doc
comment carries the same v1/v2 summary; `validateRoot` rejects any
`kortix_version` above `KNOWN_SCHEMA_VERSION` or a v2+ manifest written as
TOML.)

A v3 manifest that still sets the legacy singular `runtime` field, or a
top-level `opencode:` table, is rejected outright with a pointer to the
`runtimes` map / the harness's own `config_dir` (`validateManifestBodyV3` in
`packages/manifest-schema/src/index.ts`).

### Validator + schema artifacts

- `validateManifest(input, format)` — the imperative validator described
  above; dispatches on `kortix_version` to `validateManifestBodyV1/V2/V3`.
- `manifestJsonSchema(version)` — returns the frozen JSON Schema fragment for
  `1 | 2 | 3 | 'combined'` (`packages/manifest-schema/src/json-schema.ts`).
  `manifestJsonSchema(3)` is `KORTIX_V3_JSON_SCHEMA`.
- Published, served copies: `apps/web/public/schema/kortix.v3.schema.json`
  (also `kortix.v1.schema.json`, `kortix.v2.schema.json`, and the combined
  `kortix.schema.json` that dispatches on `kortix_version`). These are
  generated by `bun run generate:schema`
  (`packages/manifest-schema/scripts/generate-schema.ts`) and guarded against
  drift by `src/__tests__/json-schema.sync.test.ts` — that test fails if the
  committed files don't byte-match what the generator would produce.
- `V3_HARNESS_VALUES` (`packages/manifest-schema/src/constants.ts`) — the
  enum `validateRuntimesV3` checks `harness` against. It is derived from
  `@kortix/shared`'s `HARNESS_IDS` (`packages/shared/src/harnesses.ts`), not
  redeclared: `export const V3_HARNESS_VALUES = [...HARNESS_IDS] as const;`.
  A dedicated drift-guard test
  (`packages/manifest-schema/src/__tests__/harness-source.test.ts`) asserts
  `V3_HARNESS_VALUES` equals `HARNESS_IDS` exactly.
- `validateTriggerAgentRefsV2` — cross-validates a trigger's optional `agent`
  field against the declared agent names. Despite the `V2` suffix (it
  predates v3 and the name was kept for back-compat), it is reused unchanged
  for v3 (`validateManifestBodyV3` calls it against the v3 `agents` scan) and
  is exported from `@kortix/manifest-schema`'s root
  (`packages/manifest-schema/src/index.ts` re-export block).

### Current behavior: blank trigger `agent: ""` on v3 is rejected

A trigger's `agent` field, if present, must be a non-empty string naming a
declared agent — an empty string (`agent: ""`) is treated the same as any
other non-matching value and rejected with `"agent must be a non-empty string
naming a declared agent."` (`validateTriggerAgentRefsV2`,
`packages/manifest-schema/src/index.v2.ts`). This is current behavior, pinned
by a dedicated test:
`apps/api/src/projects/triggers.v3.test.ts`, test `'v3: blank agent string is
rejected (pins current strictness — product decision pending, see cycle
ledger WS1-P1-c note)'`. Before that pin, a blank agent silently fell back to
`default_agent`; whether to restore that fallback for v3 is an open product
decision, not settled by this reference.

## v2 → v3 migration

`migrateManifestV2ToV3(manifest)`
(`apps/api/src/projects/lib/agent-config-v2.ts`) losslessly promotes a v2
manifest's governance to v3 ACP-native routing:

- Refuses non-v2 input: `manifest.schemaVersion !== 2` returns
  `{ ok: false, error: 'Only a kortix_version 2 manifest can be upgraded to v3.' }`.
- For every entry in the v2 `agents:` map, adds `runtime: 'opencode'` and
  `agent: <the map key>` to that agent's existing governance fields — every
  agent keeps its original name as its native OpenCode agent id.
- Injects 4 default runtime profiles regardless of what the project uses,
  so every official harness becomes selectable going forward:
  `DEFAULT_RUNTIME_PROFILES_V3` = `opencode` (`.kortix/opencode`), `claude`
  (`.claude`), `codex` (`.codex`), `pi` (`.pi`).
- Drops the legacy singular `opencode:` key from the manifest (destructured
  out before writing `runtimes`).
- Sets `kortix_version: 3`.
- Re-validates the result with `validateManifest` before returning success;
  any validation error aborts the migration with the collected issues
  (`errorIssues`) rather than writing a broken manifest.
- Never touches native harness files — the doc comment on the function reads
  "Native OpenCode behavior files remain untouched; every existing logical
  agent initially keeps OpenCode while the other official harnesses become
  selectable."

Migration is opt-in, not automatic: it runs behind
`POST /{projectId}/runtime-profiles/enable`
(`apps/api/src/projects/routes/agent-config.ts`), which no-ops (returns the
existing `runtimes`) if the project is already on v3, calls
`migrateManifestV2ToV3` otherwise, and commits the resulting manifest to the
project's default branch only on success.

## What's parsed where (v3-relevant surfaces)

| Surface | What it reads |
| --- | --- |
| Session/trigger launch | `runtimes.<name>.harness` + `config_dir` to select and boot the ACP adapter |
| Session token mint | `agents.<name>` (connectors/secrets/skills/kortix_cli/workspace grant) |
| Trigger sweep | `triggers:`, cross-checked against `agents` names via `validateTriggerAgentRefsV2` |

Everything else (`project:`, `env:`, `sandbox:`, `triggers:` field shapes,
`connectors:`) keeps the same structure as v1/v2 — see the version-specific
validators in `packages/manifest-schema/src/index.ts` for the exact rules.
