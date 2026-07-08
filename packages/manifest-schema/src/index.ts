/**
 * Canonical kortix.toml schema + validator.
 *
 * One source of truth, exercised wherever manifest input is accepted:
 *
 *   1. `kortix ship` (CLI) — pre-flight validation before push. A broken
 *      manifest fails fast with a colored diagnostic, no push happens.
 *   2. Backend CR-merge gate — backstop so manifests pushed without the CLI
 *      (raw git push, web edit) still can't take a project down.
 *   3. `kortix validate` (CLI) — explicit subcommand that just runs the
 *      validator and prints a report.
 *
 * Errors are structured (path + severity + message + optional line/col) so
 * callers can render them however they want. The validator is pure: no I/O,
 * no DB calls, just `(rawToml: string | object) → ManifestValidationResult`.
 */

import { TomlError } from 'smol-toml';
import { type ManifestFormat, parseManifestText } from './format';
import {
  CHANNEL_PLATFORMS,
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_POLICY_ACTIONS,
  CONNECTOR_PROVIDERS,
  ENV_NAME_RE,
  GRANTABLE_KORTIX_CLI_ACTIONS,
  LEGACY_SANDBOX_KEYS,
  LEGACY_TOLERATED_KORTIX_CLI_ACTIONS,
  RESERVED_SANDBOX_SLUG,
  RESERVED_SLUG_PROVIDERS,
  SANDBOX_CPU_BOUNDS,
  SANDBOX_DISK_BOUNDS,
  SANDBOX_MEMORY_BOUNDS,
  SLUG_RE,
  TRIGGER_TYPES,
} from './constants';
// The 7 below (v2-only enums/regex) are no longer consumed directly in this
// file — validateAgentMdFrontmatter and friends moved to ./index.v2.ts, which
// imports them itself — but are kept in the re-export block just below for
// `@kortix/manifest-schema` backward compatibility.
import {
  rejectChannelsV2,
  validateAgentsV2,
  validateDefaultAgentV2,
  validateRuntimeV2,
  validateTriggerAgentRefsV2,
} from './index.v2';

export {
  type ManifestFormat,
  type ManifestCandidate,
  MANIFEST_FILENAME_TOML,
  MANIFEST_FILENAME_YAML,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  serializeManifestObject,
} from './format';

// Re-exported for backward compatibility — these lived as local `const`s in
// this file until the `constants.ts` extraction (see that module's doc for
// why: it broke an index.ts ⇄ json-schema.ts import cycle).
export {
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
  WORKSPACE_MODES_V2,
} from './constants';

// Re-exported for backward compatibility — the v2 types + validators lived
// in this file until the `index.v2.ts` extraction (thermo-nuclear-review
// FIX 1: this file had grown to ~1900 lines, and the v2 surface was one
// cohesive, contiguous, ~525-line block). See index.v2.ts's header for why
// splitting it out this way doesn't reintroduce the index.ts ⇄ json-schema.ts
// cycle that `constants.ts` had to break.
export {
  type AgentModeV2,
  type WorkspaceModeV2,
  type RuntimeV2,
  type PermissionActionV2,
  type PermissionRuleV2,
  type PermissionConfigObjectV2,
  type PermissionConfigV2,
  type GrantSetV2,
  type AgentBlockV2,
  type ManifestV2,
  resolveGrantSet,
  validatePermissionConfig,
  validateAgentMdFrontmatter,
} from './index.v2';

/**
 * Maximum manifest schema version this validator understands.
 *
 * v1 = `[[agents]]` array overlay, TOML or YAML, `[[channels]]` allowed.
 * v2 = `agents:` map — GOVERNANCE ONLY (connectors/secrets/skills/kortix_cli/
 * workspace/enabled); OpenCode behavior (mode/model/temperature/top_p/steps/
 * variant/color/hidden/permission/prompt) lives entirely in the agent's own
 * native `.kortix/opencode/agents/<name>.md` frontmatter + body, never in
 * this manifest. YAML-only, `[[channels]]` removed, deny-by-default grant
 * sets. See docs/specs/2026-07-05-agent-first-config-unification.md
 * §2.1/§2.2/§2.7 (decision 2026-07-05: "one home per concern").
 */
const KNOWN_SCHEMA_VERSION = 2;

/**
 * True when `v` is a value the runtime's `coerceBool` recognizes for an
 * `enabled` flag (apps/api/.../triggers.ts coerceBool). The runtime accepts
 * booleans, 0/1, and the strings true/false/1/0/yes/no/on/off (case-insensitive)
 * — the gate must accept the same set or it falsely rejects manifests that
 * materialize fine. Genuine garbage (e.g. "maybe", a table) is still flagged.
 */
function isEnabledValue(v: unknown): boolean {
  if (typeof v === 'boolean' || typeof v === 'number') return true;
  if (typeof v === 'string') {
    return ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(v.trim().toLowerCase());
  }
  return false;
}

/** One diagnostic finding. */
export interface ManifestIssue {
  /** Dot-path to the offending value, e.g. `triggers[1].cron`. */
  path: string;
  /** Human-readable message. */
  message: string;
  /** `error` blocks push/merge; `warning` is advisory. */
  severity: 'error' | 'warning';
  /** Optional 1-indexed line within the original TOML text. */
  line?: number;
  /** Optional 1-indexed column. */
  column?: number;
}

export interface ManifestValidationResult {
  /** True iff there are zero `error` issues. */
  valid: boolean;
  /** The parsed manifest object (null when the TOML failed to parse at all). */
  parsed: Record<string, unknown> | null;
  /** All issues, both `error` and `warning`. */
  issues: ManifestIssue[];
}

/**
 * Validate a manifest. Accepts either the raw manifest string (canonical input
 * for CLI / git pushes) or an already-parsed object. When given a string, pass
 * the `format` so it's parsed with the right parser — defaults to TOML for
 * backward compatibility; pass `'yaml'` for a `kortix.yaml`.
 */
export function validateManifest(
  input: string | Record<string, unknown>,
  format: ManifestFormat = 'toml',
): ManifestValidationResult {
  const issues: ManifestIssue[] = [];
  let parsed: Record<string, unknown> | null = null;

  if (typeof input === 'string') {
    try {
      parsed = parseManifestText(input, format);
    } catch (err) {
      // Both parsers expose a source position, in different shapes: TomlError
      // carries flat line/column; the yaml package's YAMLParseError carries a
      // `linePos` array of { line, col }.
      const pos = err as {
        line?: unknown;
        column?: unknown;
        linePos?: Array<{ line?: number; col?: number }>;
      };
      const line = typeof pos.line === 'number' ? pos.line : pos.linePos?.[0]?.line;
      const column = typeof pos.column === 'number' ? pos.column : pos.linePos?.[0]?.col;
      issues.push({
        path: err instanceof TomlError ? '<toml>' : `<${format}>`,
        message: `Syntax error: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error',
        line: typeof line === 'number' ? line : undefined,
        column: typeof column === 'number' ? column : undefined,
      });
      return { valid: false, parsed: null, issues };
    }
  } else {
    parsed = input;
  }

  const version = validateRoot(parsed, format, issues);

  if (version === 2) {
    validateManifestBodyV2(parsed, issues);
  } else {
    validateManifestBodyV1(parsed, issues);
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    parsed,
    issues,
  };
}

/**
 * kortix_version 1 section validators — UNCHANGED from before v2 existed.
 * Byte-for-byte the same calls as always; v1 manifests must keep validating
 * identically no matter what v2 support is added alongside it.
 */
function validateManifestBodyV1(parsed: Record<string, unknown>, issues: ManifestIssue[]): void {
  validateProject(parsed.project, 'project', issues);
  validateEnv(parsed.env, 'env', issues);
  validateOpenCode(parsed.opencode, 'opencode', issues);
  validateSandbox(parsed.sandbox, 'sandbox', issues);
  rejectLegacySandboxes(parsed.sandboxes, 'sandboxes', issues);
  validateTriggers(parsed.triggers, 'triggers', issues);
  validateConnectors(parsed.connectors, 'connectors', issues, 1);
  validateAgents(parsed.agents, 'agents', issues);
  validateChannels(parsed.channels, 'channels', issues);
  validateApps(parsed.apps, 'apps', issues);
}

/**
 * kortix_version 2 section validators. Every v1 top-level section keeps its
 * v1 shape/validation (project, env, opencode, sandbox, triggers, connectors,
 * apps — spec §2.7/§5); `agents` becomes a name→block map (§2.2), `channels`
 * is removed (§2.5), and `default_agent` + `runtime` are new top-level keys
 * (§2.1/§2.3).
 */
function validateManifestBodyV2(parsed: Record<string, unknown>, issues: ManifestIssue[]): void {
  validateProject(parsed.project, 'project', issues);
  validateEnv(parsed.env, 'env', issues);
  validateOpenCode(parsed.opencode, 'opencode', issues);
  validateSandbox(parsed.sandbox, 'sandbox', issues);
  rejectLegacySandboxes(parsed.sandboxes, 'sandboxes', issues);
  validateTriggers(parsed.triggers, 'triggers', issues);
  validateConnectors(parsed.connectors, 'connectors', issues, 2);
  validateApps(parsed.apps, 'apps', issues);
  rejectChannelsV2(parsed.channels, 'channels', issues);
  validateRuntimeV2(parsed.runtime, 'runtime', issues);
  const { names: agentNames, disabledNames } = validateAgentsV2(parsed.agents, 'agents', issues);
  validateDefaultAgentV2(parsed.default_agent, 'default_agent', agentNames, disabledNames, issues);
  validateTriggerAgentRefsV2(parsed.triggers, 'triggers', agentNames, issues);
}

/** Format issues into a colored, console-friendly multi-line string. */
export function formatIssues(issues: ManifestIssue[], opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  return issues
    .map((i) => {
      const tag = i.severity === 'error' ? red('error') : yellow('warning');
      const where = i.line ? ` ${dim(`(line ${i.line}${i.column ? `:${i.column}` : ''})`)}` : '';
      return `  ${tag} ${dim(i.path)}: ${i.message}${where}`;
    })
    .join('\n');
}

// ─── Section validators ───────────────────────────────────────────────────

/**
 * Validate a `connectors` / `kortix_cli` grant value (array | "all" | "none").
 *
 * `version` only changes how a `kortix_cli` entry from
 * `LEGACY_TOLERATED_KORTIX_CLI_ACTIONS` is treated (only reachable when
 * `checkAction` is true): v1 keeps it a warning (these actions were REMOVED
 * from enforcement, not from v1's manifest shape — an existing manifest that
 * still lists one must keep validating, just with a deprecation nudge). v2 is
 * a clean break, same as its other removed-field rejections (`per_user`
 * credential, the `[[channels]]` section, the pre-redirect agent-block
 * fields): a legacy action in a NEW schema version is a hard error.
 */
// Exported (not just used locally) so `./index.v2.ts`'s v2 agent-block
// validator can reuse it — same grant-set shape/action rules for both
// manifest versions, see that call site.
export function validateGrantList(
  value: unknown,
  where: string,
  label: string,
  issues: ManifestIssue[],
  checkAction: boolean,
  version: 1 | 2 = 1,
): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    // Runtime parseGrantSet treats "" the same as "none" (default-deny).
    const v = value.trim().toLowerCase();
    if (v !== '' && v !== 'all' && v !== 'none') {
      issues.push({
        path: where,
        message: `${label} string must be "all" or "none" (or an array of names).`,
        severity: 'error',
      });
    }
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({
      path: where,
      message: `${label} must be an array of strings, "all", or "none".`,
      severity: 'error',
    });
    return;
  }
  value.forEach((item, k) => {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push({
        path: `${where}[${k}]`,
        message: `${label} entries must be non-empty strings.`,
        severity: 'error',
      });
      return;
    }
    const s = item.trim();
    if (checkAction && s !== '*' && !GRANTABLE_KORTIX_CLI_ACTIONS.includes(s)) {
      if (LEGACY_TOLERATED_KORTIX_CLI_ACTIONS.includes(s)) {
        issues.push({
          path: `${where}[${k}]`,
          message:
            version === 2
              ? `"${s}" is a deprecated, no-op kortix_cli action (removed from enforcement) and is not tolerated in kortix_version 2 — remove it from the manifest.`
              : `"${s}" is a deprecated, no-op kortix_cli action (removed from enforcement — granting or omitting it has no effect). Remove it from the manifest.`,
          severity: version === 2 ? 'error' : 'warning',
        });
      } else {
        issues.push({
          path: `${where}[${k}]`,
          message: `"${s}" is not a grantable kortix_cli action (allowed: project.*; account-scoped actions can never be granted to an agent).`,
          severity: 'error',
        });
      }
    }
  });
}

/** `[[agents]]` — the per-agent scoping overlay (name + connectors + kortix_cli). */
function validateAgents(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`agents` must be an array of tables — use `[[agents]]`.',
      severity: 'error',
    });
    return;
  }
  const seen = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      issues.push({ path: `${where}.name`, message: 'name is required.', severity: 'error' });
    } else if (!SLUG_RE.test(name)) {
      issues.push({
        path: `${where}.name`,
        message: `"${name}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
    } else if (seen.has(name)) {
      issues.push({
        path: `${where}.name`,
        message: `duplicate agent name "${name}".`,
        severity: 'error',
      });
    } else {
      seen.add(name);
    }
    validateGrantList(entry.connectors, `${where}.connectors`, 'connectors', issues, false);
    validateGrantList(entry.kortix_cli, `${where}.kortix_cli`, 'kortix_cli', issues, true);
    // `env` (project-secret allowlist) shares the same array | "all" | "none"
    // shape as connectors/kortix_cli (runtime parseGrantSet, no per-entry
    // action check). Omitted defaults to "all" at runtime (back-compat — a
    // NEW dimension must not starve existing agents), so absence is not an
    // error here either; validateGrantList already no-ops on undefined/null.
    validateGrantList(entry.env, `${where}.env`, 'env', issues, false);
  });
}

/**
 * Validate `kortix_version` and resolve which section-validator set applies.
 * Returns the parsed version number so the caller can dispatch to the v1 or
 * v2 body validators — `undefined` only when the field itself is missing or
 * not a valid positive integer (nothing sensible to dispatch on).
 */
function validateRoot(
  raw: Record<string, unknown>,
  format: ManifestFormat,
  issues: ManifestIssue[],
): number | undefined {
  const versionRaw = raw.kortix_version;
  if (versionRaw == null) {
    issues.push({
      path: 'kortix_version',
      message: 'kortix_version is required — add `kortix_version = 1` at the top.',
      severity: 'error',
    });
    return undefined;
  }
  const version = typeof versionRaw === 'number' ? versionRaw : Number.NaN;
  if (!Number.isFinite(version) || version < 1 || Math.floor(version) !== version) {
    issues.push({
      path: 'kortix_version',
      message: `kortix_version must be a positive integer (got ${JSON.stringify(versionRaw)}).`,
      severity: 'error',
    });
    return undefined;
  }
  if (version > KNOWN_SCHEMA_VERSION) {
    issues.push({
      path: 'kortix_version',
      message: `Unsupported schema version ${version}. This tool understands up to v${KNOWN_SCHEMA_VERSION}; upgrade the CLI or pin the manifest.`,
      severity: 'error',
    });
    return version;
  }
  // v2's nested permission trees, per-value secret scoping, and approval lists
  // are genuinely awkward in TOML (spec §2.7) — TOML sunsets at v1. Point at
  // the migration path rather than silently misparsing.
  if (version === 2 && format === 'toml') {
    issues.push({
      path: 'kortix_version',
      message:
        'kortix_version 2 manifests must be kortix.yaml (TOML only supports kortix_version 1). Rename the file to kortix.yaml or run `kortix migrate`.',
      severity: 'error',
    });
    return version;
  }
  return version;
}

function validateProject(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return; // optional
  if (!isTable(node)) {
    issues.push({ path, message: '[project] must be a table.', severity: 'error' });
    return;
  }
  expectStringOrAbsent(node.name, `${path}.name`, issues);
  expectStringOrAbsent(node.description, `${path}.description`, issues);
}

function validateEnv(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '[env] must be a table.', severity: 'error' });
    return;
  }
  for (const key of ['required', 'optional'] as const) {
    const val = node[key];
    if (val == null) continue;
    if (!Array.isArray(val)) {
      issues.push({
        path: `${path}.${key}`,
        message: `must be an array of env-var names.`,
        severity: 'error',
      });
      continue;
    }
    val.forEach((item, i) => {
      const where = `${path}.${key}[${i}]`;
      if (typeof item !== 'string') {
        issues.push({ path: where, message: `must be a string env-var name.`, severity: 'error' });
        return;
      }
      const upper = item.trim().toUpperCase();
      if (!ENV_NAME_RE.test(upper)) {
        issues.push({
          path: where,
          message: `"${item}" is not a valid env-var name (uppercase letters, digits, underscores; must not start with a digit).`,
          severity: 'error',
        });
      }
    });
  }
  // Reject unknown keys to catch typos early.
  for (const key of Object.keys(node)) {
    if (!['required', 'optional'].includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `Unknown [env] key "${key}". Expected one of: required, optional.`,
        severity: 'warning',
      });
    }
  }
}

function validateOpenCode(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '[opencode] must be a table.', severity: 'error' });
    return;
  }
  expectRelativePathOrAbsent(node.config_dir, `${path}.config_dir`, issues);
}

/**
 * Validate the `[sandbox]` namespace. The image definitions live under
 * `[[sandbox.templates]]` (array of tables). The `[sandbox]` table itself
 * carries no direct image keys — those belonged to the removed singular
 * `[sandbox]` table, so any that linger are flagged as legacy.
 */
function validateSandbox(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({
      path,
      message: '`[sandbox]` must be a table holding `[[sandbox.templates]]` entries.',
      severity: 'error',
    });
    return;
  }
  // Legacy singular `[sandbox]` shape: image/build keys set directly on the
  // table instead of inside a `[[sandbox.templates]]` entry. Reject with a
  // migration hint rather than silently ignoring them. `LEGACY_SANDBOX_KEYS`
  // lives in constants.ts (shared with json-schema.ts's `sandboxSchema`).
  const stray = LEGACY_SANDBOX_KEYS.filter((k) => node[k] !== undefined);
  if (stray.length > 0) {
    issues.push({
      path,
      message: `The singular \`[sandbox]\` table is no longer supported. Define each image under \`[[sandbox.templates]]\` (array of tables) with a named slug, and remove the \`${stray.join('`, `')}\` key${stray.length === 1 ? '' : 's'} from \`[sandbox]\`.`,
      severity: 'error',
    });
  }
  validateSandboxTemplates(node.templates, `${path}.templates`, issues);

  // `default` selects which template EVERY session in the project boots
  // (UI, triggers, channels) without passing `sandbox_slug`. It must name a
  // template defined above, or the reserved "default" (the platform image).
  if (node.default !== undefined) {
    const want = typeof node.default === 'string' ? node.default.trim() : '';
    if (!want) {
      issues.push({
        path: `${path}.default`,
        message: '`default` must be a non-empty template slug.',
        severity: 'error',
      });
    } else if (want !== RESERVED_SANDBOX_SLUG) {
      const slugs = Array.isArray(node.templates)
        ? node.templates
            .filter(isTable)
            .map((t) =>
              typeof (t as Record<string, unknown>).slug === 'string'
                ? ((t as Record<string, unknown>).slug as string).trim()
                : '',
            )
            .filter(Boolean)
        : [];
      if (!slugs.includes(want)) {
        issues.push({
          path: `${path}.default`,
          message: `\`default\` = "${want}" does not match any \`[[sandbox.templates]]\` slug (or the reserved "${RESERVED_SANDBOX_SLUG}").`,
          severity: 'error',
        });
      }
    }
  }
}

function validateSandboxTemplates(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message:
        '`sandbox.templates` must be an array of tables — use `[[sandbox.templates]]`, not `[sandbox.templates]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug (lowercase letters, digits, dashes, underscores; max 128 chars).`,
        severity: 'error',
      });
    } else if (slug === RESERVED_SANDBOX_SLUG) {
      issues.push({
        path: `${where}.slug`,
        message: `slug "${RESERVED_SANDBOX_SLUG}" is reserved for the platform default — use any other slug.`,
        severity: 'error',
      });
    } else if (seenSlugs.has(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `duplicate slug "${slug}" — slugs must be unique within a project.`,
        severity: 'error',
      });
    } else {
      seenSlugs.add(slug);
    }
    // The runtime caps sandbox-template slugs at 64 chars (apps/api dockerfile-layer
    // SLUG_RE) — a longer slug parses here but is silently dropped at sync, so warn.
    if (slug && SLUG_RE.test(slug) && slug.length > 64) {
      issues.push({
        path: `${where}.slug`,
        message: `slug is ${slug.length} chars; the runtime caps template slugs at 64, so this template would be silently dropped at sync. Shorten it.`,
        severity: 'warning',
      });
    }
    const hasImage = typeof entry.image === 'string' && entry.image.trim() !== '';
    const hasDockerfile = typeof entry.dockerfile === 'string' && entry.dockerfile.trim() !== '';
    if (hasImage && hasDockerfile) {
      issues.push({
        path: where,
        message: 'set exactly one of `image` or `dockerfile`, not both.',
        severity: 'error',
      });
    }
    if (!hasImage && !hasDockerfile) {
      issues.push({
        path: where,
        message: 'set one of `image` or `dockerfile`.',
        severity: 'error',
      });
    }
    if (hasImage && typeof entry.image === 'string') {
      const img = entry.image.trim();
      if (img.endsWith(':latest')) {
        issues.push({
          path: `${where}.image`,
          message: 'Pin a specific tag instead of "latest" (e.g. `python:3.12-slim`).',
          severity: 'warning',
        });
      } else if (!img.includes(':') && !img.includes('@')) {
        issues.push({
          path: `${where}.image`,
          message:
            'Image reference must include a tag (e.g. `:3.12-slim`) or digest (`@sha256:…`).',
          severity: 'error',
        });
      }
    }
    if (hasDockerfile && typeof entry.dockerfile === 'string') {
      expectRelativePathOrAbsent(entry.dockerfile, `${where}.dockerfile`, issues);
    }
    expectStringOrAbsent(entry.name, `${where}.name`, issues);
    expectStringOrAbsent(entry.entrypoint, `${where}.entrypoint`, issues);
    expectBoundedIntOrAbsent(entry.cpu, `${where}.cpu`, SANDBOX_CPU_BOUNDS, issues);
    expectBoundedIntOrAbsent(entry.memory, `${where}.memory`, SANDBOX_MEMORY_BOUNDS, issues);
    expectBoundedIntOrAbsent(entry.disk, `${where}.disk`, SANDBOX_DISK_BOUNDS, issues);
    if (entry.gpu !== undefined) {
      issues.push({
        path: `${where}.gpu`,
        message: 'GPU specs are not supported in this version. Remove the `gpu` key.',
        severity: 'warning',
      });
    }
  });
}

function rejectLegacySandboxes(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined) return;
  issues.push({
    path,
    message:
      '`[[sandboxes]]` has been renamed to `[[sandbox.templates]]`. The fields are unchanged — rename each `[[sandboxes]]` header to `[[sandbox.templates]]` and remove the old block.',
    severity: 'error',
  });
}

function validateTriggers(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`triggers` must be an array of tables — use `[[triggers]]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug.`,
        severity: 'error',
      });
    } else if (seenSlugs.has(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `duplicate slug "${slug}".`,
        severity: 'error',
      });
    } else {
      seenSlugs.add(slug);
    }
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    if (!(TRIGGER_TYPES as readonly string[]).includes(type)) {
      issues.push({
        path: `${where}.type`,
        message: `type must be one of: ${TRIGGER_TYPES.join(', ')} (got "${type || 'unset'}").`,
        severity: 'error',
      });
    }
    // Aliases below mirror the runtime parser's input tolerance
    // (apps/api/.../triggers.ts parseTriggerEntry): `prompt`/`prompt_template`,
    // `cron`/`schedule`, `run_at`/`runAt`, `secret_env`/`secretEnv`,
    // `session_mode`/`sessionMode`. The gate must accept whatever the runtime
    // accepts, or it falsely blocks a manifest that materializes fine.
    const promptRaw =
      typeof entry.prompt === 'string'
        ? entry.prompt
        : typeof entry.prompt_template === 'string'
          ? entry.prompt_template
          : '';
    if (!promptRaw.trim()) {
      issues.push({
        path: `${where}.prompt`,
        message: 'prompt is required and may not be empty.',
        severity: 'error',
      });
    }
    if (type === 'cron') {
      const cron =
        typeof entry.cron === 'string'
          ? entry.cron.trim()
          : typeof entry.schedule === 'string'
            ? entry.schedule.trim()
            : '';
      // A one-off ("run once") schedule carries `run_at` (ISO-8601 instant)
      // instead of a recurring `cron` expression — exactly one must be set.
      const runAt =
        typeof entry.run_at === 'string'
          ? entry.run_at.trim()
          : typeof entry.runAt === 'string'
            ? entry.runAt.trim()
            : '';
      if (runAt) {
        if (Number.isNaN(Date.parse(runAt))) {
          issues.push({
            path: `${where}.run_at`,
            message: 'run_at must be an ISO-8601 datetime (e.g. 2026-06-01T09:00:00Z).',
            severity: 'error',
          });
        }
      } else if (!cron) {
        issues.push({
          path: `${where}.cron`,
          message: 'cron triggers must declare a `cron` expression or a one-off `run_at`.',
          severity: 'error',
        });
      }
      if (entry.timezone !== undefined && typeof entry.timezone !== 'string') {
        issues.push({
          path: `${where}.timezone`,
          message: 'timezone must be an IANA string.',
          severity: 'error',
        });
      } else if (
        typeof entry.timezone === 'string' &&
        entry.timezone.trim() &&
        !isValidIanaTimeZone(entry.timezone.trim())
      ) {
        // Runtime rejects a non-IANA zone (e.g. "PST") and the trigger never fires.
        issues.push({
          path: `${where}.timezone`,
          message: `"${entry.timezone}" is not a valid IANA time zone (e.g. "America/New_York"); the runtime rejects it and the trigger would never fire.`,
          severity: 'warning',
        });
      }
    } else if (type === 'webhook') {
      const secret =
        typeof entry.secret_env === 'string'
          ? entry.secret_env.trim()
          : typeof entry.secretEnv === 'string'
            ? entry.secretEnv.trim()
            : '';
      if (!secret) {
        issues.push({
          path: `${where}.secret_env`,
          message: 'webhook triggers must declare a `secret_env`.',
          severity: 'error',
        });
      } else if (!ENV_NAME_RE.test(secret)) {
        issues.push({
          path: `${where}.secret_env`,
          message: `"${secret}" is not a valid env-var name.`,
          severity: 'error',
        });
      }
    }
    if (entry.enabled !== undefined && !isEnabledValue(entry.enabled)) {
      issues.push({
        path: `${where}.enabled`,
        message: 'enabled must be a boolean.',
        severity: 'error',
      });
    }
    const sessionModeRaw =
      typeof entry.session_mode === 'string'
        ? entry.session_mode
        : typeof entry.sessionMode === 'string'
          ? entry.sessionMode
          : undefined;
    if (sessionModeRaw !== undefined) {
      const sessionMode = sessionModeRaw.trim().toLowerCase();
      if (sessionMode !== 'fresh' && sessionMode !== 'reuse') {
        issues.push({
          path: `${where}.session_mode`,
          message: 'session_mode must be "fresh" or "reuse".',
          severity: 'error',
        });
      }
    }
  });
}

function validateConnectors(node: unknown, path: string, issues: ManifestIssue[], version: 1 | 2 = 1): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`connectors` must be an array of tables — use `[[connectors]]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug.`,
        severity: 'error',
      });
    } else if (seenSlugs.has(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `duplicate slug "${slug}".`,
        severity: 'error',
      });
    } else {
      seenSlugs.add(slug);
    }
    // Runtime parser lowercases provider/auth.type/policy.action/platform before
    // matching — mirror that so a manifest using "MCP" or "Slack" isn't blocked.
    const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
    if (provider === 'computer') {
      // Synth-only: a `computer` connector materializes when a machine is
      // connected over the Agent Computer Tunnel — it is never declared by hand.
      issues.push({
        path: `${where}.provider`,
        message:
          'provider="computer" is managed automatically when you connect a machine (Computers) — it cannot be declared in kortix.toml.',
        severity: 'error',
      });
    } else if (!(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) {
      issues.push({
        path: `${where}.provider`,
        message: `provider must be one of: ${CONNECTOR_PROVIDERS.join(', ')} (got "${provider || 'unset'}").`,
        severity: 'error',
      });
    }
    // Reserved platform-owned slugs accept only their built-in provider.
    const reservedProvider = RESERVED_SLUG_PROVIDERS[slug];
    if (reservedProvider && provider !== reservedProvider) {
      issues.push({
        path: `${where}.provider`,
        message: `"${slug}" is reserved for the built-in ${reservedProvider} connector (provider="${reservedProvider}").`,
        severity: 'error',
      });
    }
    if (provider === 'pipedream' && typeof entry.app !== 'string') {
      issues.push({
        path: `${where}.app`,
        message: 'pipedream connectors require `app`.',
        severity: 'error',
      });
    }
    if (provider === 'mcp' && typeof entry.url !== 'string') {
      issues.push({
        path: `${where}.url`,
        message: 'mcp connectors require `url`.',
        severity: 'error',
      });
    }
    if (provider === 'graphql' && typeof entry.endpoint !== 'string') {
      issues.push({
        path: `${where}.endpoint`,
        message: 'graphql connectors require `endpoint`.',
        severity: 'error',
      });
    }
    if (
      provider === 'http' &&
      typeof entry.base_url !== 'string' &&
      typeof entry.baseUrl !== 'string'
    ) {
      issues.push({
        path: `${where}.base_url`,
        message: 'http connectors require `base_url`.',
        severity: 'error',
      });
    }
    if (provider === 'channel') {
      const platform =
        typeof entry.platform === 'string' ? entry.platform.trim().toLowerCase() : '';
      if (!(CHANNEL_PLATFORMS as readonly string[]).includes(platform)) {
        issues.push({
          path: `${where}.platform`,
          message: `channel connectors require \`platform\` one of: ${CHANNEL_PLATFORMS.join(', ')} (got "${platform || 'unset'}").`,
          severity: 'error',
        });
      }
    }
    // Advisory: the runtime parser enforces the rules below, but the gate stays
    // non-blocking (warnings) so a hand-edited manifest is never hard-rejected —
    // it just surfaces what would fail to materialize at runtime.
    if (provider === 'mcp' && entry.transport !== undefined) {
      const tr = typeof entry.transport === 'string' ? entry.transport.trim().toLowerCase() : '';
      if (tr !== 'http' && tr !== 'sse') {
        issues.push({
          path: `${where}.transport`,
          message: `transport should be "http" or "sse" (got "${tr || 'unset'}"); the runtime rejects anything else.`,
          severity: 'warning',
        });
      }
    }
    if (provider === 'openapi' && typeof entry.spec !== 'string') {
      issues.push({
        path: `${where}.spec`,
        message:
          'openapi connectors need a `spec` (URL or repo path); without it the connector fails to materialize.',
        severity: 'warning',
      });
    }
    if (entry.credential !== undefined) {
      const cm = typeof entry.credential === 'string' ? entry.credential.trim().toLowerCase() : '';
      if (cm === 'per_user') {
        // `per_user` (each member brings their own) was removed 2026-07-05
        // (docs/specs/2026-07-05-agent-first-config-unification.md §2.5).
        // v1 tolerates it as a legacy value — it always resolves to `shared`
        // at runtime and is never round-tripped back into git. v2 is a clean
        // break: reject it outright, same as the removed CLI actions.
        issues.push({
          path: `${where}.credential`,
          message:
            version === 2
              ? 'credential "per_user" is not supported in kortix_version 2 — connectors are always "shared"; remove this key.'
              : 'credential "per_user" was removed — it is tolerated here for now and resolves to "shared", but should be removed from the manifest.',
          severity: version === 2 ? 'error' : 'warning',
        });
      } else if (cm !== 'shared') {
        // The runtime (apps/api's connectors.ts `parseConnectorEntry`)
        // HARD-REJECTS any credential value that isn't "shared" or the
        // tolerated legacy "per_user" — the whole `[[connectors]]` entry
        // fails to parse there, it is not advisory. v2 mirrors that as a
        // real error (same clean-break intent as the `per_user` branch
        // above and every other v2 removed-field rejection). v1 keeps this
        // a warning — consistent with this function's other v1-only soft
        // checks (mcp `transport`, openapi `spec`) — so a hand-edited v1
        // manifest is never hard-blocked by the CR-merge gate over a value
        // the runtime would separately reject at sync time; the author
        // still sees the warning either way.
        issues.push({
          path: `${where}.credential`,
          message: `credential should be "shared" (got "${cm || 'unset'}"); the runtime rejects anything else.`,
          severity: version === 2 ? 'error' : 'warning',
        });
      }
    }
    if (entry.agent_scope !== undefined) {
      // The connector-side agent gate was removed 2026-07 (wave-2 of the
      // agent-first cut, docs/specs/2026-07-05-agent-first-config-unification.md
      // §2.5): connector access is now purely the agent's own `connectors`
      // grant (`[[agents]].connectors` in v1, `agents.<name>.connectors` in
      // v2). The runtime (apps/api's connectors.ts `parseConnectorEntry`) no
      // longer reads `agent_scope` at all — it parses fine and is simply
      // dropped, never round-tripped back into git (unit-connectors-parse
      // "agent_scope is retired" test). Same clean-break pattern as the
      // `credential: per_user` removal above: v1 tolerates the stray legacy
      // key as a deprecation warning, v2 is a hard error.
      issues.push({
        path: `${where}.agent_scope`,
        message:
          version === 2
            ? 'agent_scope is not supported in kortix_version 2 — connector access is set on the agent (`connectors` grant); remove this key.'
            : 'agent_scope is no longer used — connector access is set on the agent (`connectors` grant), not on the connector. This key is ignored at runtime; remove it from the manifest.',
        severity: version === 2 ? 'error' : 'warning',
      });
    }
    if (provider === 'pipedream' && entry.auth !== undefined) {
      issues.push({
        path: `${where}.auth`,
        message:
          'pipedream connectors authenticate via the connected account — [connectors.auth] is ignored at runtime.',
        severity: 'warning',
      });
    }
    // Optional [connectors.auth]
    if (entry.auth !== undefined) {
      const auth = entry.auth;
      if (!isTable(auth)) {
        issues.push({ path: `${where}.auth`, message: 'auth must be a table.', severity: 'error' });
      } else {
        const t = typeof auth.type === 'string' ? auth.type.trim().toLowerCase() : '';
        if (!(CONNECTOR_AUTH_TYPES as readonly string[]).includes(t)) {
          issues.push({
            path: `${where}.auth.type`,
            message: `auth.type must be one of: ${CONNECTOR_AUTH_TYPES.join(', ')} (got "${t || 'unset'}").`,
            severity: 'error',
          });
        }
        if (provider === 'channel' && t !== 'none') {
          issues.push({
            path: `${where}.auth`,
            message:
              'channel connectors authenticate via the platform install token — omit [connectors.auth].',
            severity: 'error',
          });
        }
        if (t === 'oauth1' && provider !== 'openapi' && provider !== 'http') {
          issues.push({
            path: `${where}.auth.type`,
            message: 'auth.type "oauth1" is only supported for openapi/http connectors.',
            severity: 'error',
          });
        }
        if (auth.secret !== undefined) {
          issues.push({
            path: `${where}.auth.secret`,
            message:
              'auth.secret is no longer supported; set connector credentials in the platform.',
            severity: 'error',
          });
        }
      }
    }
    // Optional [[connectors.policies]]
    if (entry.policies !== undefined) {
      const policies = entry.policies;
      if (!Array.isArray(policies)) {
        issues.push({
          path: `${where}.policies`,
          message: 'connectors.policies must be an array of tables.',
          severity: 'error',
        });
      } else {
        policies.forEach((p, j) => {
          const pwhere = `${where}.policies[${j}]`;
          if (!isTable(p)) {
            issues.push({ path: pwhere, message: 'must be a table.', severity: 'error' });
            return;
          }
          if (typeof p.match !== 'string' || !p.match.trim()) {
            issues.push({
              path: `${pwhere}.match`,
              message: 'match glob is required.',
              severity: 'error',
            });
          }
          const action = typeof p.action === 'string' ? p.action.trim().toLowerCase() : '';
          if (!(CONNECTOR_POLICY_ACTIONS as readonly string[]).includes(action)) {
            issues.push({
              path: `${pwhere}.action`,
              message: `action must be one of: ${CONNECTOR_POLICY_ACTIONS.join(', ')} (got "${action || 'unset'}").`,
              severity: 'error',
            });
          }
        });
      }
    }
  });
}

function validateChannels(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`channels` must be an array of tables — use `[[channels]]`.',
      severity: 'error',
    });
    return;
  }
  const seenPlatforms = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const platform = typeof entry.platform === 'string' ? entry.platform.trim() : '';
    if (!platform) {
      issues.push({
        path: `${where}.platform`,
        message: 'platform is required (e.g. "slack").',
        severity: 'error',
      });
    } else if (seenPlatforms.has(platform)) {
      issues.push({
        path: `${where}.platform`,
        message: `duplicate platform "${platform}" — one [[channels]] entry per platform per project.`,
        severity: 'error',
      });
    } else {
      seenPlatforms.add(platform);
    }
    if (entry.enabled !== undefined && !isEnabledValue(entry.enabled)) {
      issues.push({
        path: `${where}.enabled`,
        message: 'enabled must be a boolean.',
        severity: 'error',
      });
    }
    if (entry.events !== undefined) {
      if (!Array.isArray(entry.events)) {
        issues.push({
          path: `${where}.events`,
          message: 'events must be an array of strings.',
          severity: 'error',
        });
      } else {
        entry.events.forEach((ev, j) => {
          if (typeof ev !== 'string') {
            issues.push({
              path: `${where}.events[${j}]`,
              message: 'must be a string.',
              severity: 'error',
            });
          }
        });
      }
    }
  });
}

function validateApps(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`apps` must be an array of tables — use `[[apps]]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug.`,
        severity: 'error',
      });
    } else if (seenSlugs.has(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `duplicate slug "${slug}".`,
        severity: 'error',
      });
    } else {
      seenSlugs.add(slug);
    }
    expectStringOrAbsent(entry.name, `${where}.name`, issues);
    expectStringOrAbsent(entry.framework, `${where}.framework`, issues);
    if (entry.enabled !== undefined && !isEnabledValue(entry.enabled)) {
      issues.push({
        path: `${where}.enabled`,
        message: 'enabled must be a boolean.',
        severity: 'error',
      });
    }
    if (entry.domains !== undefined) {
      if (!Array.isArray(entry.domains)) {
        issues.push({
          path: `${where}.domains`,
          message: 'domains must be an array of strings.',
          severity: 'error',
        });
      } else {
        entry.domains.forEach((d, j) => {
          if (typeof d !== 'string') {
            issues.push({
              path: `${where}.domains[${j}]`,
              message: 'must be a string.',
              severity: 'error',
            });
          }
        });
      }
    }
    if (entry.source === undefined) {
      // The runtime requires [apps.source]; without it the app never deploys.
      issues.push({
        path: `${where}.source`,
        message:
          'no [apps.source] declared; the runtime requires one, so this app will not deploy.',
        severity: 'warning',
      });
    } else if (!isTable(entry.source)) {
      issues.push({
        path: `${where}.source`,
        message: 'source must be a table.',
        severity: 'error',
      });
    } else {
      const type = typeof entry.source.type === 'string' ? entry.source.type : '';
      if (type !== 'git' && type !== 'tar') {
        issues.push({
          path: `${where}.source.type`,
          message: `source.type must be "git" or "tar" (got "${type || 'unset'}").`,
          severity: 'error',
        });
      } else if (type === 'tar' && typeof entry.source.url !== 'string') {
        issues.push({
          path: `${where}.source.url`,
          message: 'tar sources need a `url`; without it the app fails to deploy.',
          severity: 'warning',
        });
      }
    }
    if (entry.build !== undefined && !isTable(entry.build)) {
      issues.push({ path: `${where}.build`, message: 'build must be a table.', severity: 'error' });
    }
    if (entry.env !== undefined) {
      if (!isTable(entry.env)) {
        issues.push({
          path: `${where}.env`,
          message: 'env must be a table of string KEY=VALUE pairs.',
          severity: 'error',
        });
      } else {
        // The runtime rejects non-string values and non-env-name keys; warn so a
        // hand-edited manifest isn't blocked but the author sees what will fail.
        for (const [k, v] of Object.entries(entry.env)) {
          if (typeof v !== 'string') {
            issues.push({
              path: `${where}.env.${k}`,
              message: 'app env values must be strings; the runtime rejects non-string values.',
              severity: 'warning',
            });
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
            issues.push({
              path: `${where}.env.${k}`,
              message: `"${k}" is not a valid env-var name; the runtime rejects it.`,
              severity: 'warning',
            });
          }
        }
      }
    }
  });
}

// ─── kortix_version 2 types + validators ──────────────────────────────────
// Extracted to ./index.v2.ts (thermo-nuclear-review FIX 1) — re-exported
// below for backward compatibility, and imported here for dispatch from
// validateManifestBodyV2. See index.v2.ts's header for the cycle rationale.

// ─── Primitive helpers ────────────────────────────────────────────────────

// Exported so `./index.v2.ts` can reuse it — see that module's header for
// why this creates a safe (non-eager) cross-import cycle with this file.
export function isTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A valid IANA time-zone name (the runtime rejects anything else). */
function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Exported so `./index.v2.ts`'s `validateAgentMdFrontmatter` can reuse it.
export function expectStringOrAbsent(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string.', severity: 'error' });
  }
}

function expectRelativePathOrAbsent(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string path.', severity: 'error' });
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    issues.push({ path, message: 'must not be empty.', severity: 'error' });
    return;
  }
  if (trimmed.startsWith('/')) {
    issues.push({
      path,
      message: 'must be a path relative to the repo root (no leading "/").',
      severity: 'error',
    });
    return;
  }
  if (trimmed.split('/').includes('..')) {
    issues.push({
      path,
      message: 'must not contain ".." path segments.',
      severity: 'error',
    });
  }
}

function expectBoundedIntOrAbsent(
  value: unknown,
  path: string,
  bounds: { min: number; max: number },
  issues: ManifestIssue[],
): void {
  if (value === undefined || value === null) return;
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num) || num <= 0) {
    issues.push({ path, message: `must be a positive integer.`, severity: 'error' });
    return;
  }
  if (Math.floor(num) !== num) {
    issues.push({ path, message: `must be an integer.`, severity: 'error' });
    return;
  }
  if (num < bounds.min) {
    issues.push({ path, message: `must be ≥ ${bounds.min}.`, severity: 'error' });
  } else if (num > bounds.max) {
    issues.push({
      path,
      message: `must be ≤ ${bounds.max} (clamped at runtime, but pin a sane value in source).`,
      severity: 'warning',
    });
  }
}

// The canonical, public JSON Schema (`./json-schema.ts`) is built FROM the
// constants above (GRANTABLE_KORTIX_CLI_ACTIONS, CONNECTOR_PROVIDERS,
// AGENT_MODES_V2, …), so it imports this module — this re-export must stay
// the LAST statement in the file: json-schema.ts's own top-level code calls
// its builder functions eagerly (`export const KORTIX_V1_JSON_SCHEMA =
// buildManifestV1Schema()`), so by the time this circular import resolves
// (whichever module loads first), every constant it needs must already be
// initialized — which only holds if everything above has already run.
export {
  type JsonSchemaFragment,
  KORTIX_SCHEMA_BASE_URL,
  KORTIX_V1_JSON_SCHEMA,
  KORTIX_V2_JSON_SCHEMA,
  KORTIX_JSON_SCHEMA,
  buildManifestV1Schema,
  buildManifestV2Schema,
  buildManifestSchema,
  manifestJsonSchema,
} from './json-schema';
