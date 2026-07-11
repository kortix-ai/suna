/**
 * The canonical, PUBLIC JSON Schema for `kortix.toml` / `kortix.yaml` —
 * the Kortix equivalent of opencode's https://opencode.ai/config.json.
 *
 * This is DATA generated from the same constants/enums the imperative
 * validator (`./index.ts`) uses (`GRANTABLE_KORTIX_CLI_ACTIONS`,
 * `CONNECTOR_PROVIDERS`, `AGENT_MODES_V2`, `WORKSPACE_MODES_V2`, …) so the
 * two can never silently drift apart — see the conformance test
 * (`__tests__/json-schema.conformance.test.ts`), which runs a shared fixture
 * corpus through both `validateManifest` and this schema (via ajv) and
 * fails CI on any accept/reject disagreement.
 *
 * Three documents are published (see `apps/web/public/schema/` +
 * `scripts/generate-schema.ts`):
 *
 *   - `kortix.v1.schema.json` — the `[[agents]]`-array / `[[channels]]` shape.
 *   - `kortix.v2.schema.json` — the `agents:`-map, governance-only shape.
 *   - `kortix.schema.json`    — BOTH, dispatched by an `if/then` on
 *     `kortix_version` (const 1 vs const 2), so ONE URL always validates
 *     whichever version a manifest declares.
 *
 * Deliberate scope limits (documented, not bugs — see spec header of
 * `./index.ts` and the conformance test):
 *
 *   - Cross-field / dynamic-set rules the imperative validator enforces by
 *     reading OTHER parts of the same document at runtime — `default_agent`
 *     must name a key present in the (arbitrary, project-defined) `agents`
 *     map, a trigger's `agent` must do the same, `sandbox.default` must name
 *     a declared template slug — have no static JSON Schema encoding
 *     (would need non-standard `$data` references). These stay
 *     imperative-only; the schema is intentionally silent on them.
 *   - Warning-level rules (case-insensitive "all"/"none" sentinels, GPU-key
 *     deprecation, image `:latest` tag nudge, missing `[apps.source]`,
 *     sandbox-template-slug length, non-IANA trigger `timezone`, …) never
 *     flip `valid`, so the schema does not need to encode them for the two
 *     validators to agree on accept/reject. `enabled`'s true/false/1/0/yes/
 *     no/on/off string sentinels are the opposite (an ERROR-level check in
 *     `isEnabledValue`), so those ARE encoded structurally — see
 *     `enabledValueSchema` — not left to this warning-level exemption.
 */

import {
  AGENT_MODES_V2,
  AGENT_THEME_COLORS_V2,
  CHANNEL_PLATFORMS,
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_POLICY_ACTIONS,
  CONNECTOR_PROVIDERS,
  ENV_NAME_RE,
  GRANTABLE_KORTIX_CLI_ACTIONS,
  HEX_COLOR_RE_V2,
  LEGACY_SANDBOX_KEYS,
  LEGACY_TOLERATED_KORTIX_CLI_ACTIONS,
  PERMISSION_ACTION_ONLY_KEYS_V2,
  PERMISSION_ACTIONS_V2,
  RESERVED_SANDBOX_SLUG,
  RESERVED_SLUG_PROVIDERS,
  SANDBOX_CPU_BOUNDS,
  SANDBOX_DISK_BOUNDS,
  SANDBOX_MEMORY_BOUNDS,
  SLUG_RE,
  TRIGGER_TYPES,
  V2_RUNTIME_VALUES,
  V3_HARNESS_VALUES,
  WORKSPACE_MODES_V2,
} from './constants';

/** A JSON Schema fragment — plain data, no `$id`/`$schema` (those belong on
 *  the top-level documents only). Kept loose (not the full 2020-12 meta-type)
 *  since this module hand-assembles the tree; ajv is what checks it's legal. */
// biome-ignore lint: recursive JSON Schema shape, `unknown` would fight every builder below
export type JsonSchemaFragment = Record<string, any>;

export const KORTIX_SCHEMA_BASE_URL = 'https://kortix.com/schema';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** Case-sensitive uppercase env-var-name pattern (matches `ENV_NAME_RE`) —
 *  used where the runtime tests the raw value with no case-folding first
 *  (trigger `secret_env`). */
const ENV_NAME_PATTERN = ENV_NAME_RE.source;

/** `[env].required`/`optional` entries are upper-cased by the validator
 *  BEFORE the `ENV_NAME_RE` test (`item.trim().toUpperCase()`), so any-case
 *  input is actually accepted — the real constraint is the case-INsensitive
 *  version of the same shape. */
const ENV_NAME_PATTERN_CASE_INSENSITIVE = '^[A-Za-z_][A-Za-z0-9_]*$';

const NON_EMPTY_STRING: JsonSchemaFragment = { type: 'string', minLength: 1 };

/** The `connectors` / `secrets` / `skills` / `kortix_cli` grant-set shape:
 *  an allowlist of names, or the "all"/"none" sentinel (spec §2.2/§2.4/§2.5).
 *  `itemSchema` lets `kortix_cli` additionally constrain each entry to the
 *  grantable-action enum. */
function grantSetSchema(itemSchema: JsonSchemaFragment = NON_EMPTY_STRING): JsonSchemaFragment {
  return {
    description: 'An allowlist of names, or the "all" / "none" sentinel.',
    oneOf: [
      { type: 'array', items: itemSchema },
      { type: 'string', enum: ['all', 'none'] },
    ],
  };
}

/**
 * Every string a `kortix_cli` grant-list entry may legally be, version-gated
 * to mirror `validateGrantList`'s clean break (`./index.ts`): v1 still
 * tolerates the legacy no-op actions (warning, not error — an existing
 * manifest that lists one must keep validating), so its enum is the live
 * grantable catalog PLUS the legacy set. v2 hard-rejects them, so its enum
 * is the live grantable catalog ONLY. Both always accept the `"*"` wildcard.
 */
function kortixCliEnum(version: 1 | 2 | 3): readonly string[] {
  return version >= 2
    ? [...GRANTABLE_KORTIX_CLI_ACTIONS, '*']
    : [...GRANTABLE_KORTIX_CLI_ACTIONS, ...LEGACY_TOLERATED_KORTIX_CLI_ACTIONS, '*'];
}

function kortixCliGrantSetSchema(version: 1 | 2 | 3): JsonSchemaFragment {
  return grantSetSchema({ type: 'string', enum: [...kortixCliEnum(version)] });
}

/** `PermissionRuleConfig`: a bare action, or a glob-pattern → action map. */
function permissionRuleSchema(): JsonSchemaFragment {
  return {
    oneOf: [
      { type: 'string', enum: [...PERMISSION_ACTIONS_V2] },
      {
        type: 'object',
        additionalProperties: { type: 'string', enum: [...PERMISSION_ACTIONS_V2] },
      },
    ],
  };
}

/** `PermissionConfig`: a bare action applied to everything, or an object
 *  keyed by tool/capability — full OpenCode parity (mirrors
 *  `validatePermissionConfig` in `./index.ts`). */
function permissionConfigSchema(): JsonSchemaFragment {
  const actionOnlyProps = Object.fromEntries(
    PERMISSION_ACTION_ONLY_KEYS_V2.map((key) => [key, { type: 'string', enum: [...PERMISSION_ACTIONS_V2] }]),
  );
  return {
    oneOf: [
      { type: 'string', enum: [...PERMISSION_ACTIONS_V2] },
      {
        type: 'object',
        properties: { ...actionOnlyProps },
        additionalProperties: permissionRuleSchema(),
      },
    ],
  };
}

/** An agent's native `.kortix/opencode/agents/<name>.md` frontmatter — full
 *  OpenCode `AgentConfig` parity (mirrors `validateAgentMdFrontmatter`). Not
 *  part of the manifest schema's own tree (frontmatter lives in a sibling
 *  file the manifest never embeds) — published as a `$defs` entry on the v2
 *  document purely as a documentation/authoring aid for editors that also
 *  understand frontmatter, since the manifest's `agents.<name>` map is the
 *  join key for this file's path. */
function agentMdFrontmatterSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    description:
      "OpenCode behavior for one agent — lives in .kortix/opencode/agents/<name>.md frontmatter, never in the manifest. Provided here as an authoring aid; not itself part of kortix.yaml.",
    properties: {
      description: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string', enum: [...AGENT_MODES_V2] },
      variant: { type: 'string' },
      temperature: { type: 'number' },
      top_p: { type: 'number' },
      steps: { type: 'integer', minimum: 1 },
      color: {
        oneOf: [
          { type: 'string', pattern: HEX_COLOR_RE_V2.source },
          { type: 'string', enum: [...AGENT_THEME_COLORS_V2] },
        ],
      },
      hidden: { type: 'boolean' },
      disable: { type: 'boolean' },
      options: { type: 'object' },
      permission: permissionConfigSchema(),
    },
    additionalProperties: true,
  };
}

const SLUG_SCHEMA: JsonSchemaFragment = { type: 'string', pattern: SLUG_RE.source };

/** A regex matching a leading `/` (absolute path) OR any `..` path segment
 *  (start, middle, or end) — the same two rejections `expectRelativePathOrAbsent`
 *  (`./index.ts`) applies to every repo-relative path field. `(^|/)\.\.($|/)`
 *  matches `..`, `../x`, `x/..`, and `x/../y` without false-positiving on a
 *  legitimate segment like `foo..bar` (no `/` or start immediately before the
 *  `..`, and no `/` or end immediately after it). */
const PATH_TRAVERSAL_OR_ABSOLUTE_PATTERN = String.raw`^/|(^|/)\.\.($|/)`;

/** Every case-variant of one of `isEnabledValue`'s (`./index.ts`) accepted
 *  sentinel words, turned into a case-insensitive regex alternative (JSON
 *  Schema `pattern` has no `/i` flag) — e.g. `true` → `[Tt][Rr][Uu][Ee]`. */
function caseInsensitiveLiteral(word: string): string {
  return word.replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

const ENABLED_SENTINEL_WORDS = ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'] as const;

/** `enabled` field shape — mirrors `isEnabledValue` (`./index.ts`) exactly:
 *  a boolean, a number, or (case-insensitively) one of true/false/1/0/yes/
 *  no/on/off as a string. Shared by triggers/apps/channels, which all defer
 *  to the same runtime `coerceBool`. */
function enabledValueSchema(): JsonSchemaFragment {
  return {
    oneOf: [
      { type: 'boolean' },
      { type: 'number' },
      {
        type: 'string',
        pattern: `^(?:${ENABLED_SENTINEL_WORDS.map(caseInsensitiveLiteral).join('|')})$`,
      },
    ],
  };
}

/** A repo-relative path field: non-empty, no leading `/`, no `..` segment —
 *  mirrors `expectRelativePathOrAbsent` (`./index.ts`). Shared by
 *  `[opencode].config_dir` and `[[sandbox.templates]].dockerfile`, the two
 *  manifest fields that field feeds a path into the CR-merge git worktree, so
 *  a traversal there is a real escape, not just cosmetic. */
function relativePathSchema(): JsonSchemaFragment {
  return {
    type: 'string',
    minLength: 1,
    not: { pattern: PATH_TRAVERSAL_OR_ABSOLUTE_PATTERN },
  };
}

/** `[project]` — dashboard metadata only, no required keys, no unknown-key check. */
function projectSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
    additionalProperties: true,
  };
}

/** `[env]` — env-var name lists. Unknown keys are a WARNING only
 *  (`validateEnv`), so `additionalProperties: true` here to keep parity. */
function envSchema(): JsonSchemaFragment {
  const nameList = { type: 'array', items: { type: 'string', pattern: ENV_NAME_PATTERN_CASE_INSENSITIVE } };
  return {
    type: 'object',
    properties: { required: nameList, optional: nameList },
    additionalProperties: true,
  };
}

/** `[opencode]` — just the runtime config-dir path. */
function opencodeSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    properties: {
      config_dir: relativePathSchema(),
    },
    additionalProperties: true,
  };
}

/** One `[[sandbox.templates]]` entry. */
function sandboxTemplateSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['slug'],
    properties: {
      slug: { allOf: [SLUG_SCHEMA, { not: { const: RESERVED_SANDBOX_SLUG } }] },
      name: { type: 'string' },
      entrypoint: { type: 'string' },
      image: { type: 'string', minLength: 1 },
      dockerfile: relativePathSchema(),
      cpu: { type: 'integer', minimum: SANDBOX_CPU_BOUNDS.min },
      memory: { type: 'integer', minimum: SANDBOX_MEMORY_BOUNDS.min },
      disk: { type: 'integer', minimum: SANDBOX_DISK_BOUNDS.min },
    },
    // Exactly one of image/dockerfile (`validateSandboxTemplates`).
    oneOf: [
      { required: ['image'], not: { required: ['dockerfile'] } },
      { required: ['dockerfile'], not: { required: ['image'] } },
    ],
  };
}

/** `[sandbox]` — templates array + default slug. The legacy singular-table
 *  image keys are explicitly forbidden (`rejectLegacySandbox` error path);
 *  any OTHER unknown key on this table is untouched by the validator, so
 *  `additionalProperties: true` for parity. */
function sandboxSchema(): JsonSchemaFragment {
  const forbiddenLegacy = Object.fromEntries(LEGACY_SANDBOX_KEYS.map((k) => [k, false]));
  return {
    type: 'object',
    properties: {
      ...forbiddenLegacy,
      templates: { type: 'array', items: sandboxTemplateSchema() },
      // Cross-field: must name a declared template slug — dynamic, left to
      // the imperative validator (see module doc "deliberate scope limits").
      default: { type: 'string', minLength: 1 },
    },
    additionalProperties: true,
  };
}

/** One `[[triggers]]` entry — cron or webhook (`validateTriggers`). */
function triggerSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['slug', 'type'],
    properties: {
      slug: SLUG_SCHEMA,
      type: { type: 'string', enum: [...TRIGGER_TYPES] },
      name: { type: 'string' },
      // Cross-field: must name a declared agent (or be omitted) — dynamic,
      // left to the imperative validator.
      agent: { type: 'string', minLength: 1 },
      agent_name: { type: 'string', minLength: 1 },
      enabled: enabledValueSchema(),
      session_mode: { type: 'string', enum: ['fresh', 'reuse'] },
      sessionMode: { type: 'string', enum: ['fresh', 'reuse'] },
      prompt: NON_EMPTY_STRING,
      prompt_template: NON_EMPTY_STRING,
      cron: { type: 'string', minLength: 1 },
      schedule: { type: 'string', minLength: 1 },
      run_at: { type: 'string', minLength: 1 },
      runAt: { type: 'string', minLength: 1 },
      timezone: { type: 'string' },
      secret_env: { type: 'string', pattern: ENV_NAME_PATTERN },
      secretEnv: { type: 'string', pattern: ENV_NAME_PATTERN },
    },
    additionalProperties: true,
    allOf: [
      // A prompt (or its alias) is always required, non-empty.
      { anyOf: [{ required: ['prompt'] }, { required: ['prompt_template'] }] },
      {
        if: { properties: { type: { const: 'cron' } } },
        then: {
          // A recurring `cron`/`schedule`, or a one-off `run_at`/`runAt`.
          anyOf: [
            { required: ['cron'] },
            { required: ['schedule'] },
            { required: ['run_at'] },
            { required: ['runAt'] },
          ],
        },
      },
      {
        if: { properties: { type: { const: 'webhook' } } },
        then: { anyOf: [{ required: ['secret_env'] }, { required: ['secretEnv'] }] },
      },
    ],
  };
}

/** Platform-owned connector slugs and the one provider each may use
 *  (`RESERVED_SLUG_PROVIDERS`) — structural (static map), so encodable.
 *  Derived by iterating every entry (rather than a hand-written subset) so a
 *  new reserved slug (or `computer`) is automatically covered here too — a
 *  hand-written 2-entry list once let a connector declare `slug = "computer"`
 *  with a non-`computer` provider and still validate structurally, since
 *  nothing in this array checked it (the "computer-slug accept bug"). */
const RESERVED_SLUG_CONST_CHECKS: JsonSchemaFragment[] = Object.entries(RESERVED_SLUG_PROVIDERS).map(
  ([slug, provider]) => ({
    if: { properties: { slug: { const: slug } } },
    then: { properties: { provider: { const: provider } } },
  }),
);

/** One `[[connectors]]` entry. `version` only changes two fields:
 *
 *  - `credential`: v2 hard-rejects anything but `"shared"` (the legacy
 *    `"per_user"` INCLUDED — a clean break, matching the runtime's own hard
 *    parse-error for any non-shared/non-per_user value, connectors.ts
 *    `parseConnectorEntry`), v1 leaves it unconstrained here since every v1
 *    case is warning-level only (spec §2.5) — see `validateConnectors`.
 *  - `agent_scope`: the connector-side agent gate, removed 2026-07 (wave-2 —
 *    access is now purely the agent's own `connectors` grant). The runtime
 *    no longer reads this key at all (parses fine, silently dropped). v1
 *    tolerates the stray legacy key (warning-level only, so unconstrained
 *    here); v2 forbids it outright (`false` schema — matches the `auth.secret`
 *    forbidden-key pattern below) — see `validateConnectors`. */
function connectorSchema(version: 1 | 2): JsonSchemaFragment {
  const credentialSchema: JsonSchemaFragment = version === 2 ? { const: 'shared' } : {};
  const agentScopeSchema: JsonSchemaFragment | boolean = version === 2 ? false : {};
  return {
    type: 'object',
    required: ['slug', 'provider'],
    properties: {
      slug: SLUG_SCHEMA,
      // `computer` is deliberately excluded — synth-only, never hand-authored.
      provider: { type: 'string', enum: [...CONNECTOR_PROVIDERS] },
      app: { type: 'string' },
      url: { type: 'string' },
      endpoint: { type: 'string' },
      base_url: { type: 'string' },
      baseUrl: { type: 'string' },
      transport: { type: 'string', enum: ['http', 'sse'] },
      spec: { type: 'string' },
      platform: { type: 'string', enum: [...CHANNEL_PLATFORMS] },
      credential: credentialSchema,
      agent_scope: agentScopeSchema,
      auth: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: [...CONNECTOR_AUTH_TYPES] },
          secret: false,
        },
        additionalProperties: true,
      },
      policies: {
        type: 'array',
        items: {
          type: 'object',
          required: ['match', 'action'],
          properties: {
            match: NON_EMPTY_STRING,
            action: { type: 'string', enum: [...CONNECTOR_POLICY_ACTIONS] },
          },
        },
      },
    },
    additionalProperties: true,
    allOf: [
      ...RESERVED_SLUG_CONST_CHECKS,
      { if: { properties: { provider: { const: 'pipedream' } } }, then: { required: ['app'] } },
      { if: { properties: { provider: { const: 'mcp' } } }, then: { required: ['url'] } },
      { if: { properties: { provider: { const: 'graphql' } } }, then: { required: ['endpoint'] } },
      {
        if: { properties: { provider: { const: 'http' } } },
        then: { anyOf: [{ required: ['base_url'] }, { required: ['baseUrl'] }] },
      },
      { if: { properties: { provider: { const: 'channel' } } }, then: { required: ['platform'] } },
      // channel connectors authenticate via the platform install token.
      {
        if: {
          properties: { provider: { const: 'channel' } },
          required: ['auth'],
        },
        then: { properties: { auth: { properties: { type: { const: 'none' } } } } },
      },
    ],
  };
}

/** `[[channels]]` — v1 only; removed outright in v2 (spec §2.5). */
function channelSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['platform'],
    properties: {
      platform: NON_EMPTY_STRING,
      enabled: enabledValueSchema(),
      events: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  };
}

/** One `[[apps]]` entry. */
function appSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['slug'],
    properties: {
      slug: SLUG_SCHEMA,
      name: { type: 'string' },
      framework: { type: 'string' },
      enabled: enabledValueSchema(),
      domains: { type: 'array', items: { type: 'string' } },
      source: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['git', 'tar'] },
          repo: { type: 'string' },
          branch: { type: 'string' },
          root_path: { type: 'string' },
          url: { type: 'string' },
        },
        additionalProperties: true,
      },
      build: { type: 'object' },
      env: { type: 'object' },
    },
    additionalProperties: true,
  };
}

/** `[[agents]]` (v1) — the array-of-tables governance overlay. */
function agentEntryV1Schema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['name'],
    properties: {
      name: SLUG_SCHEMA,
      connectors: grantSetSchema(),
      kortix_cli: kortixCliGrantSetSchema(1),
      env: grantSetSchema(),
    },
    additionalProperties: true,
  };
}

/** `agents.<name>` (v2) — GOVERNANCE ONLY (spec §2.2). Every OpenCode
 *  behavioral field is a hard validation error here — modeled by simply
 *  never listing them in `properties` + `additionalProperties: false`, so
 *  any of them (or a stray `env`, the v1 name) fails as "not allowed". */
function agentBlockV2Schema(): JsonSchemaFragment {
  return {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      connectors: grantSetSchema(),
      secrets: grantSetSchema(),
      skills: grantSetSchema(),
      kortix_cli: kortixCliGrantSetSchema(2),
      workspace: { type: 'string', enum: [...WORKSPACE_MODES_V2] },
    },
    additionalProperties: false,
  };
}

function runtimeBlockV3Schema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['harness'],
    properties: {
      harness: { type: 'string', enum: [...V3_HARNESS_VALUES] },
      config_dir: relativePathSchema(),
    },
    additionalProperties: false,
  };
}

function agentBlockV3Schema(): JsonSchemaFragment {
  return {
    type: 'object',
    required: ['runtime'],
    properties: {
      runtime: NON_EMPTY_STRING,
      agent: NON_EMPTY_STRING,
      enabled: { type: 'boolean' },
      connectors: grantSetSchema(),
      secrets: grantSetSchema(),
      skills: grantSetSchema(),
      kortix_cli: kortixCliGrantSetSchema(3),
      workspace: { type: 'string', enum: [...WORKSPACE_MODES_V2] },
    },
    additionalProperties: false,
  };
}

/** Sections shared byte-for-byte between v1 and v2 (spec §2.7: "every v1
 *  top-level section keeps its v1 shape" except `agents`/`channels`). */
function sharedSectionProperties(connectorVersion: 1 | 2): JsonSchemaFragment {
  return {
    project: projectSchema(),
    env: envSchema(),
    opencode: opencodeSchema(),
    sandbox: sandboxSchema(),
    // `[[sandboxes]]` was renamed — always a hard error, so forbid it.
    sandboxes: false,
    triggers: { type: 'array', items: triggerSchema() },
    connectors: { type: 'array', items: connectorSchema(connectorVersion) },
    apps: { type: 'array', items: appSchema() },
  };
}

/** `kortix_version: 1` body. */
export function buildManifestV1Schema(): JsonSchemaFragment {
  return {
    $schema: DRAFT,
    $id: `${KORTIX_SCHEMA_BASE_URL}/kortix.v1.schema.json`,
    title: 'Kortix manifest (kortix_version 1)',
    description:
      'kortix.toml / kortix.yaml, schema version 1 — `[[agents]]` is a per-agent governance ' +
      'OVERLAY (connectors/kortix_cli/env grants); absence means an unrestricted default agent ' +
      '(adopt-to-govern back-compat). `[[channels]]` is accepted (validated, though dead at ' +
      'runtime — see docs/specs/2026-07-05-agent-first-config-unification.md §1.5).',
    type: 'object',
    required: ['kortix_version'],
    properties: {
      kortix_version: { const: 1 },
      ...sharedSectionProperties(1),
      agents: { type: 'array', items: agentEntryV1Schema() },
      channels: { type: 'array', items: channelSchema() },
    },
    additionalProperties: true,
  };
}

/** `kortix_version: 2` body. */
export function buildManifestV2Schema(): JsonSchemaFragment {
  return {
    $schema: DRAFT,
    $id: `${KORTIX_SCHEMA_BASE_URL}/kortix.v2.schema.json`,
    title: 'Kortix manifest (kortix_version 2)',
    description:
      'kortix.yaml, schema version 2 — YAML-only. `agents` is a name→block MAP, ' +
      'GOVERNANCE ONLY (connectors/secrets/skills/kortix_cli/workspace/enabled); every agent must ' +
      'be declared, and OpenCode behavior (description/model/mode/temperature/permission/the ' +
      'prompt itself) lives entirely in that agent’s own native ' +
      '`.kortix/opencode/agents/<name>.md` frontmatter + body — authoring any of those fields ' +
      'here is a hard error. `[[channels]]` is removed outright. See ' +
      'docs/specs/2026-07-05-agent-first-config-unification.md §2.1/§2.2/§2.5.',
    type: 'object',
    required: ['kortix_version', 'default_agent', 'agents'],
    properties: {
      kortix_version: { const: 2 },
      // Cross-field: must resolve to a declared, enabled agent — dynamic,
      // left to the imperative validator.
      default_agent: NON_EMPTY_STRING,
      runtime: { type: 'string', enum: [...V2_RUNTIME_VALUES] },
      agents: {
        type: 'object',
        minProperties: 1,
        propertyNames: { pattern: SLUG_RE.source },
        additionalProperties: agentBlockV2Schema(),
      },
      ...sharedSectionProperties(2),
      // `[[channels]]` is removed outright in v2 (spec §2.5).
      channels: false,
    },
    additionalProperties: true,
    $defs: {
      agentMdFrontmatter: agentMdFrontmatterSchema(),
    },
  };
}

/** `kortix_version: 3` ACP-first runtime profiles and logical agents. */
export function buildManifestV3Schema(): JsonSchemaFragment {
  const shared = sharedSectionProperties(2);
  delete shared.opencode;
  return {
    $schema: DRAFT,
    $id: `${KORTIX_SCHEMA_BASE_URL}/kortix.v3.schema.json`,
    title: 'Kortix manifest (kortix_version 3)',
    description:
      'kortix.yaml, schema version 3 — ACP-first. Named runtime profiles select Claude, Codex, ' +
      'OpenCode, or Pi harnesses; logical agents reference a runtime and optionally a native agent/profile id. ' +
      'Kortix owns registration and governance while prompts, models, providers, hooks, modes, and permissions ' +
      'remain in each harness native configuration.',
    type: 'object',
    required: ['kortix_version', 'default_agent', 'runtimes', 'agents'],
    properties: {
      kortix_version: { const: 3 },
      default_agent: NON_EMPTY_STRING,
      runtimes: {
        type: 'object',
        minProperties: 1,
        propertyNames: { pattern: SLUG_RE.source },
        additionalProperties: runtimeBlockV3Schema(),
      },
      agents: {
        type: 'object',
        minProperties: 1,
        propertyNames: { pattern: SLUG_RE.source },
        additionalProperties: agentBlockV3Schema(),
      },
      ...shared,
      runtime: false,
      opencode: false,
      channels: false,
    },
    additionalProperties: true,
  };
}

/**
 * The combined document: ONE stable URL that validates a manifest of
 * EITHER known version, dispatched by an `if/then` on `kortix_version`
 * (spec ask: "one single validator reference"). Each branch inlines the
 * SAME body a standalone `kortix.v1`/`kortix.v2` document would use (the
 * builder functions above are the single source for both), so this document
 * is fully self-contained — no cross-document `$ref` resolution required to
 * validate with it.
 */
export function buildManifestSchema(): JsonSchemaFragment {
  const v1 = buildManifestV1Schema();
  const v2 = buildManifestV2Schema();
  const v3 = buildManifestV3Schema();
  // Strip the per-document $id/$schema/title/description from the inlined
  // bodies — only the combined document's own carry those.
  const { $schema: _s1, $id: _i1, title: _t1, description: _d1, ...v1Body } = v1;
  const { $schema: _s2, $id: _i2, title: _t2, description: _d2, ...v2Body } = v2;
  const { $schema: _s3, $id: _i3, title: _t3, description: _d3, ...v3Body } = v3;
  return {
    $schema: DRAFT,
    $id: `${KORTIX_SCHEMA_BASE_URL}/kortix.schema.json`,
    title: 'Kortix manifest',
    description:
      'kortix.toml / kortix.yaml — combined schema covering every published `kortix_version`. ' +
      'Dispatches to the v1, v2, or v3 shape by `kortix_version`. Prefer this URL when the version is ' +
      `not known ahead of time; pin \`${KORTIX_SCHEMA_BASE_URL}/kortix.v3.schema.json\` when possible ` +
      'when it is.',
    type: 'object',
    required: ['kortix_version'],
    properties: {
      kortix_version: { type: 'integer', enum: [1, 2, 3] },
    },
    allOf: [
      { if: { properties: { kortix_version: { const: 1 } } }, then: v1Body },
      { if: { properties: { kortix_version: { const: 2 } } }, then: v2Body },
      { if: { properties: { kortix_version: { const: 3 } } }, then: v3Body },
    ],
  };
}

/** Precomputed, frozen exports — the single in-code source everything else
 *  (the CLI's `kortix schema` command, the web app's `/schema/*.json`
 *  static files, the kortix-system skill) reads from. */
export const KORTIX_V1_JSON_SCHEMA: JsonSchemaFragment = buildManifestV1Schema();
export const KORTIX_V2_JSON_SCHEMA: JsonSchemaFragment = buildManifestV2Schema();
export const KORTIX_V3_JSON_SCHEMA: JsonSchemaFragment = buildManifestV3Schema();
export const KORTIX_JSON_SCHEMA: JsonSchemaFragment = buildManifestSchema();

/** The one accessor every caller should use — "always return the correct,
 *  fully-valid schema for a given kortix_version." Pass no argument (or
 *  `'combined'`) for the single URL that dispatches on `kortix_version`. */
export function manifestJsonSchema(version: 1 | 2 | 3 | 'combined' = 'combined'): JsonSchemaFragment {
  if (version === 1) return KORTIX_V1_JSON_SCHEMA;
  if (version === 2) return KORTIX_V2_JSON_SCHEMA;
  if (version === 3) return KORTIX_V3_JSON_SCHEMA;
  return KORTIX_JSON_SCHEMA;
}
