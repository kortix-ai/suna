/**
 * Canonical kortix.yaml schema + validator.
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
 * no DB calls, just `(raw YAML string | object) → ManifestValidationResult`.
 *
 * There is one manifest format and it has no version number: it changes only by
 * adding optional keys whose defaults keep today's behavior. A breaking change
 * is never made in place. `kortix_version: 3` is obsolete and ignored (warning);
 * any other value is a retired format (error).
 */

import { Cron } from 'croner';
import { normalizeTriggerList } from './trigger-shape';
import { Document, isMap, LineCounter, parseDocument } from 'yaml';
import { type AppliedFix, applyDeprecations, DEPRECATIONS } from './deprecations';
import { legacyFormatMessage, legacyFormatOf } from './legacy';
import { areValidConditions, isValidMatcher, MAX_CONDITIONS_PER_POLICY } from './policy-rules';
import { parseConnectorHeaders } from './connector-headers';
import { normalizeImportPath } from './imports';
import { appDisplayIssues, appReleaseConfigIssues, resolveAppReleaseConfig } from '@kortix/shared/app-config';
import { appReleaseInputFromBlock } from './app-config';
import { parseChangeRequestFilter, parseTriggerFilter } from './trigger-filter';
import { validateManifestBody } from './index.v3';
import { validateAgentPolicySetRefs, validateConnectorPolicySets } from './policy-sets';
import {
  CHANNEL_PLATFORMS,
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_AUTHORIZATION_STRATEGIES,
  CONNECTOR_POLICY_ACTIONS,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  ENV_NAME_RE,
  GRANTABLE_KORTIX_PERMISSIONS,
  LEGACY_SANDBOX_KEYS,
  LEGACY_TOLERATED_KORTIX_PERMISSIONS,
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  reservedEnvNameReason,
  TRIGGER_MIN_MAX_LATENESS_SECONDS,
  DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR,
  EVENT_FORBIDDEN_KEYS,
  RESERVED_SANDBOX_SLUG,
  RESERVED_SLUG_PROVIDERS,
  SANDBOX_CPU_BOUNDS,
  SANDBOX_DISK_BOUNDS,
  SANDBOX_MEMORY_BOUNDS,
  SLUG_RE,
  TRIGGER_TYPES,
  MONITOR_REMOVED_MESSAGE,
  parseDurationSeconds,
} from './constants';
import { type AppBlockV2 } from './index.v2';

/**
 * The shortest gap between two fires of a cron trigger (KRTX-1721). Every fire
 * starts or prompts a session, and croner reads a 6-field cron seconds-first:
 * a step of 30 in the first of 6 fields is every 30 seconds, not 30 minutes.
 */
export const CRON_MIN_INTERVAL_SECONDS = 60;
/** Fires sampled for the shortest gap: enough for an irregular list such as `0,1 0 * * * *`. */
const CRON_INTERVAL_SAMPLE = 32;

/** Why `cron` fires more than once a minute, or null. `cron` must parse. */
export function cronIntervalError(cron: string, timezone = 'UTC'): string | null {
  const runs = new Cron(cron, { paused: true, timezone }).nextRuns(CRON_INTERVAL_SAMPLE);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < CRON_MIN_INTERVAL_SECONDS * 1000) {
      return `cron "${cron}" fires more than once a minute. A trigger fires at most once every ${CRON_MIN_INTERVAL_SECONDS} seconds. In a 6-field cron the first field is seconds: "0 */30 * * * *" is every 30 minutes.`;
    }
  }
  return null;
}

export {
  AGENTS_DIR,
  AGENT_FILE_PATTERN,
  MEMORY_DIR,
  SKILLS_DIR,
  TOOL_FILE_PATTERN,
  defaultAgentFile,
  safeAgentFile,
  safeToolFile,
  safeRepoPath,
} from './layout';

export {
  MANIFEST_FILENAME,
  manifestCandidatePaths,
  parseManifestText,
  serializeManifestObject,
} from './format';

export { slugifySlug } from './slug';
export {
  type LegacyChange,
  type LegacyConversion,
  type LegacyRepo,
  convertLegacyManifest,
  convertLegacyManifestAsync,
  legacyFormatMessage,
  legacyFormatOf,
  parseJsonc,
  parseLegacyToml,
  renderManifest,
  splitFrontmatter,
} from './legacy';
export { type AppliedFix, type Deprecation, DEPRECATIONS, applyDeprecations, fixManifestText } from './deprecations';
export {
  type PolicyArgCondition,
  FORBIDDEN_ARG_SEGMENTS,
  MAX_CONDITIONS_PER_POLICY,
  areValidConditions,
  isRegexMatcher,
  isValidMatcher,
} from './policy-rules';
export {
  MAX_POLICY_SETS_PER_CONNECTOR,
  MAX_RULES_PER_POLICY_SET,
  POLICY_SETS_UNSUPPORTED_PROVIDERS,
  POLICY_SET_NAME_RE,
  RESERVED_POLICY_SET_NAME,
  policySetNameError,
} from './policy-sets';
export { normalizeTriggerEntry, normalizeTriggerList } from './trigger-shape';
export {
  TRIGGER_FILTER_OPERATORS,
  parseChangeRequestFilter,
  parseTriggerFilter,
  triggerFilterValueMatches,
  type TriggerFilter,
  type TriggerFilterCondition,
  type TriggerFilterOperator,
  type TriggerFilterValue,
} from './trigger-filter';
export { appReleaseInputFromBlock } from './app-config';

export {
  type ImportableKey,
  type ManifestImportReader,
  type ManifestImportReaderSync,
  type ManifestOrigins,
  type ManifestSourceFile,
  type ResolvedManifest,
  type SplitManifestFile,
  IMPORTABLE_LIST_KEYS,
  IMPORTABLE_MAP_KEYS,
  IMPORT_PATH_PATTERN,
  MANIFEST_IMPORTS_KEY,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_FILES,
  ManifestImportError,
  hasManifestImports,
  normalizeImportPath,
  resolveManifestImports,
  resolveManifestImportsSync,
  splitManifestByOrigin,
} from './imports';

// Re-exported for backward compatibility — these lived as local `const`s in
// this file until the `constants.ts` extraction (see that module's doc for
// why: it broke an index.ts ⇄ json-schema.ts import cycle).
// `[[connectors]].headers` — arbitrary static request headers. Its own
// dependency-free module (same rationale as `constants.ts`) so the validator,
// the JSON Schema, apps/api's parser and the connector share ONE ruleset.
export {
  type ConnectorHeadersParse,
  CONNECTOR_FORBIDDEN_HEADER_NAMES,
  CONNECTOR_HEADER_NAME_RE,
  CONNECTOR_HEADER_NAME_MAX_LENGTH,
  CONNECTOR_HEADER_VALUE_MAX_LENGTH,
  CONNECTOR_HEADERS_MAX_COUNT,
  connectorHeaderNameError,
  connectorHeaderValueError,
  parseConnectorHeaders,
  sanitizeConnectorHeaders,
} from './connector-headers';

export {
  AGENT_MODES_V2,
  AGENT_THEME_COLORS_V2,
  CHANNEL_PLATFORMS,
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_AUTHORIZATION_STRATEGIES,
  CONNECTOR_POLICY_ACTIONS,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  ENV_NAME_RE,
  GRANTABLE_KORTIX_PERMISSIONS,
  HEX_COLOR_RE_V2,
  PI_PACKAGE_NPM_RE,
  PI_PACKAGE_PATH_RE,
  LEGACY_SANDBOX_KEYS,
  LEGACY_TOLERATED_KORTIX_PERMISSIONS,
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  isReservedEnvName,
  NEVER_DELIVERED_ENV_NAMES,
  PERMISSION_ACTION_ONLY_KEYS_V2,
  PERMISSION_ACTIONS_V2,
  RESERVED_ENV_NAME_PREFIXES,
  RESERVED_ENV_NAMES,
  reservedEnvNameReason,
  RESERVED_SANDBOX_SLUG,
  RESERVED_SLUG_PROVIDERS,
  TRIGGER_MIN_MAX_LATENESS_SECONDS,
  DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR,
  EVENT_FORBIDDEN_KEYS,
  DURATION_RE,
  formatDurationSeconds,
  parseDurationSeconds,
  SANDBOX_CPU_BOUNDS,
  SANDBOX_DISK_BOUNDS,
  SANDBOX_MEMORY_BOUNDS,
  SLUG_RE,
  SPACE_SLUG_RE,
  HARNESS_TOOL_NAMES,
  KORTIX_TOOL_NAMES,
  DEFAULT_ON_KORTIX_TOOLS,
  isDefaultOnKortixTool,
  KORTIX_TOOL_PREFIX,
  kortixToolRef,
  selectedKortixTools,
  TOOL_NAME_RE,
  TRIGGER_TYPES,
  MONITOR_REMOVED_MESSAGE,
  V2_RUNTIME_VALUES,
  WORKSPACE_MODES_V2,
  CODEMODE_VALUES,
  EXTENSION_HARNESSES,
  KORTIX_SKILL_NAMES,
  KORTIX_SKILL_PREFIX,
  OPENCODE_BUILTIN_AGENTS_V3,
  REGISTRY_NAME_MAX,
  REGISTRY_NAME_RE,
} from './constants';

export {
  AGENT_BLOCK_KEYS_V3,
  type AgentBlockV3,
  type AgentToolsV3,
  type CodemodeV3,
  type CommandV3,
  type ExcludableGrantSetV3,
  excludedNamesV3,
  type ExtensionV3,
  grantedNamesV3,
  type ManifestV3,
  SPACE_HEADER_ITEMS,
  SPACE_TAB_TYPES,
  type SpaceBlockV3,
  type SpaceHeaderItem,
  type SpaceTabType,
  type SpaceTabV3,
  type SpaceV3,
} from './index.v3';

// Re-exported for backward compatibility — the v2 types + validators lived
// in this file until the `index.v2.ts` extraction (thermo-nuclear-review
// FIX 1: this file had grown to ~1900 lines, and the v2 surface was one
// cohesive, contiguous, ~525-line block). See index.v2.ts's header for why
// splitting it out this way doesn't reintroduce the index.ts ⇄ json-schema.ts
// cycle that `constants.ts` had to break.
export {
  type AgentModeV2,
  type AgentWorkspaceV2,
  type ProjectRepositoryResult,
  resolveProjectRepository,
  type RuntimeV2,
  type PermissionActionV2,
  type PermissionRuleV2,
  type PermissionConfigObjectV2,
  type PermissionConfigV2,
  type GrantSetV2,
  type AppBlockV2,
  type AppResourcesV2,
  type PiPackageEntryV2,
  resolveGrantSet,
  validatePermissionConfig,
  validateAgentMdFrontmatter,
} from './index.v2';

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
  /** Human-readable message: what is wrong and how to fix it. */
  message: string;
  /**
   * `error` blocks writing the file (`kortix validate`, `kortix ship`, the
   * change-request merge gate, the editor). A running project never stops on
   * one: `usableManifest` applies the file without the broken part. `warning`
   * is advisory.
   */
  severity: 'error' | 'warning';
  /** A key the format does not have. A running project ignores it. */
  unknownKey?: true;
  /** A deprecated shape: the id of the rewrite (`DEPRECATIONS`) that `kortix validate --fix` applies. */
  fix?: string;
  /** Optional 1-indexed line within the original YAML text. */
  line?: number;
  /** Optional 1-indexed column. */
  column?: number;
}

/** Collections whose entries a running project turns off (`enabled: false`) on an error. */
const OFF_COLLECTIONS = new Set(['agents', 'triggers']);
/** Collections whose entries a running project drops on an error. */
const DROP_COLLECTIONS = new Set(['connectors', 'apps', 'skills', 'tools', 'commands', 'extensions', 'spaces', 'sandbox.templates']);
/** Settings a running project resets to their default on an error. None of them grants access. */
const RESET_KEYS = new Set(['project', 'default_agent', 'runtime']);

/**
 * What a running project applies, given the validator's issues. A key the
 * format does not have is ignored. An agent or trigger with an error is turned
 * off; a connector, app, skill, tool, command, extension, space or sandbox
 * template with an error is dropped. Each of these only takes access away.
 * `project`, `default_agent` and `runtime` fall back to their defaults. An
 * error anywhere else (`sandbox`, `env`, `approvals`, `policy`, `imports`, a
 * retired format, …) returns `{}`: the project runs its built-in agents only,
 * so My Kortix can still start and fix the file. Pure: `raw` is not changed.
 */
export function usableManifest(raw: Record<string, unknown> | null, issues: readonly ManifestIssue[]): Record<string, unknown> {
  // A legacy file is usable only once converted (`convertLegacyManifest`); unconverted it means nothing here.
  if (!raw || legacyFormatOf(raw)) return {};
  const out = structuredClone(raw);
  const drop = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (issue.severity !== 'error' || issue.unknownKey) continue;
    const m = /^(?:(sandbox)\.)?([a-z_]+)(?:\.([^.[]+)|\[(\d+)\])?/.exec(issue.path);
    const collection = m ? (m[1] ? `${m[1]}.${m[2]}` : m[2]!) : '';
    const id = m?.[3] ?? m?.[4];
    const container = collection === 'sandbox.templates' ? (out.sandbox as Record<string, unknown> | undefined)?.templates : out[collection];
    const entry = id !== undefined && container && typeof container === 'object' ? (container as Record<string, unknown>)[id] : undefined;
    if (OFF_COLLECTIONS.has(collection) && isTable(entry)) {
      entry.enabled = false;
    } else if (DROP_COLLECTIONS.has(collection) && entry !== undefined) {
      if (!drop.has(collection)) drop.set(collection, new Set());
      drop.get(collection)!.add(id!);
    } else if (!m?.[1] && RESET_KEYS.has(m?.[2] ?? '')) {
      delete out[m![2]!];
    } else {
      return {};
    }
  }
  for (const [collection, ids] of drop) {
    const holder = collection === 'sandbox.templates' ? (out.sandbox as Record<string, unknown>) : out;
    const key = collection === 'sandbox.templates' ? 'templates' : collection;
    const value = holder[key];
    holder[key] = Array.isArray(value)
      ? value.filter((_, index) => !ids.has(String(index)))
      : Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([name]) => !ids.has(name)));
  }
  return out;
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
 * Validate a manifest: the raw kortix.yaml text (CLI, git pushes) or an
 * already-parsed object.
 */
export function validateManifest(input: string | Record<string, unknown>): ManifestValidationResult {
  const issues: ManifestIssue[] = [];
  let doc: Document;
  if (typeof input === 'string') {
    doc = parseDocument(input);
    const error = doc.errors[0];
    if (error) {
      const pos = error.linePos?.[0];
      issues.push({ path: '<yaml>', message: `Syntax error: ${error.message}`, severity: 'error', line: pos?.line, column: pos?.col });
      return { valid: false, parsed: null, issues };
    }
  } else {
    doc = new Document(input);
  }
  const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  let parsed = typeof input === 'string' ? asObject(doc.toJS()) : input;

  if (validateVersionKey(parsed.kortix_version, issues)) {
    // Deprecated shapes are rewritten in memory: the body is checked, and `parsed` returned, in the latest shape.
    const fixed = applyDeprecations(doc);
    if (fixed.length > 0) {
      parsed = asObject(doc.toJS());
      issues.push(...fixed.map(deprecationIssue));
    }
    validateManifestBody(parsed, issues);
  }
  if (typeof input === 'string') locateIssues(input, issues);

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    parsed,
    issues,
  };
}

/**
 * `imports:` shape check (v2). The files themselves are resolved by
 * `resolveManifestImports` — this only guards the list a root file declares, so
 * `kortix validate` and the editor schema flag a bad path before any read.
 */
export function validateImports(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: '`imports` must be a list of paths', severity: 'error' });
    return;
  }
  value.forEach((entry, index) => {
    if (normalizeImportPath(entry) === null) {
      issues.push({
        path: `${path}[${index}]`,
        message:
          'must be a repository-relative path to a .yaml/.yml file or a directory (no "..", no absolute path, no glob)',
        severity: 'error',
      });
    }
  });
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

/** "This section must be a list" hint. */
function listSectionHint(key: string): string {
  return `\`${key}\` must be a list of entries — write it as a YAML \`${key}:\` list, not a map or scalar.`;
}

// ─── Section validators ───────────────────────────────────────────────────

/**
 * Validate a `connectors` / `kortix_permissions` grant value (array | "all" | "none").
 *
 * `version` only changes how a `kortix_permissions` entry from
 * `LEGACY_TOLERATED_KORTIX_PERMISSIONS` is treated (only reachable when
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
): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    // Runtime parseGrantSet treats "" the same as "none" (default-deny).
    const v = value.trim().toLowerCase();
    if (v !== '' && v !== 'all' && v !== '*' && v !== 'none') {
      issues.push({
        path: where,
        message: `${label} string must be "all", "*" or "none" (or an array of names).`,
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
    if (checkAction && s !== '*' && !GRANTABLE_KORTIX_PERMISSIONS.includes(s)) {
      const renamedTo = DEPRECATED_KORTIX_PERMISSION_ALIASES[s];
      if (renamedTo) {
        // A RENAMED action, not a dead one: it still resolves to a real
        // capability (`canonicalizeGrantActions` rewrites it), so this is a
        // warning in BOTH versions. Hard-rejecting it the way the no-op legacy
        // set is rejected in v2 would fail the manifest, and a manifest that
        // fails to parse gives its agent an EMPTY grant — silently stripping
        // every capability it holds rather than the one line that is outdated.
        issues.push({
          path: `${where}[${k}]`,
          message: `"${s}" was renamed to "${renamedTo.join('", "')}" — the grant still applies, but update the manifest.`,
          severity: 'warning',
        });
      } else if (LEGACY_TOLERATED_KORTIX_PERMISSIONS.includes(s)) {
        issues.push({
          path: `${where}[${k}]`,
          message: `"${s}" is a retired Kortix permission (no longer enforced). Remove it from the manifest.`,
          severity: 'error',
        });
      } else {
        issues.push({
          path: `${where}[${k}]`,
          message: `"${s}" is not a grantable Kortix permission (allowed: project.*; account-scoped actions can never be granted to an agent).`,
          severity: 'error',
        });
      }
    }
  });
}

/** Validate an agent's project-permission grant (`kortix_permissions`). The old alias `kortix_cli` is a retired agent key. */
export function validateKortixPermissionFields(entry: Record<string, unknown>, where: string, issues: ManifestIssue[]): void {
  validateGrantList(entry.kortix_permissions, `${where}.kortix_permissions`, 'kortix_permissions', issues, true);
}

/** `agents.x[0].y` → ['agents', 'x', 0, 'y']. */
function issuePathKeys(path: string): Array<string | number> {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]!));
}

/**
 * Give every issue without a position the 1-indexed line and column of its
 * path in the YAML text: the key of a map entry, the item of a list, else the
 * nearest existing parent.
 */
export function locateIssues(text: string, issues: ManifestIssue[]): void {
  if (!issues.some((issue) => issue.line === undefined)) return;
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const start = (keys: Array<string | number>): number | undefined => {
    const parent = keys.length > 1 ? doc.getIn(keys.slice(0, -1), true) : doc.contents;
    const last = keys[keys.length - 1];
    if (isMap(parent)) {
      const pair = parent.items.find((item) => (item.key as { value?: unknown } | null)?.value === last);
      return (pair?.key as { range?: [number, number, number] } | null)?.range?.[0];
    }
    return (doc.getIn(keys, true) as { range?: [number, number, number] } | undefined)?.range?.[0];
  };
  for (const issue of issues) {
    if (issue.line !== undefined) continue;
    const keys = issuePathKeys(issue.path);
    for (let n = keys.length; n > 0; n--) {
      const offset = start(keys.slice(0, n));
      if (offset === undefined) continue;
      const pos = lineCounter.linePos(offset);
      issue.line = pos.line;
      issue.column = pos.col;
      break;
    }
  }
}

/** ` Did you mean "tools"?` when one allowed key is at most 2 edits away, else ''. */
export function didYouMean(key: string, allowed: readonly string[]): string {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row[j]!;
        row[j] = next;
      }
    }
    return row[b.length]!;
  };
  const best = allowed.map((candidate) => [candidate, distance(key, candidate)] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? ` Did you mean "${best[0]}"?` : '';
}

/**
 * Approval rules `{ match, action, conditions }` (the top-level `policies` and a
 * connector's `policies`). A bad rule is an error: the runtime skips it, which
 * could silently drop a `block`.
 */
function validatePolicyRules(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  const error = (at: string, message: string): void => void issues.push({ path: at, message, severity: 'error' });
  if (!Array.isArray(node)) return error(path, listSectionHint(path));
  node.forEach((rule, index) => {
    const at = `${path}[${index}]`;
    if (!isTable(rule)) return error(at, 'must be a map: { match, action, conditions }.');
    const match = typeof rule.match === 'string' ? rule.match.trim() : '';
    if (!match) error(`${at}.match`, 'is required: a glob such as `github.*`, or a `/regex/flags`.');
    else if (!isValidMatcher(match)) error(`${at}.match`, 'is not a valid matcher: the /regex/ does not compile, or it nests quantifiers such as `(a+)+`.');
    const action = typeof rule.action === 'string' ? rule.action.trim().toLowerCase() : '';
    if (!(CONNECTOR_POLICY_ACTIONS as readonly string[]).includes(action)) {
      error(`${at}.action`, `must be one of: ${CONNECTOR_POLICY_ACTIONS.join(', ')} (got "${action || 'unset'}").`);
    }
    if (!areValidConditions(rule.conditions)) {
      error(`${at}.conditions`, `must be a list of at most ${MAX_CONDITIONS_PER_POLICY} { arg, match, negate }: \`arg\` a dotted name (not __proto__, constructor or prototype), \`match\` a glob or /regex/, \`negate\` true or false.`);
    }
  });
}

/** `policy`: the decision for a connector call no rule matches. A bad `default_mode` would fall back to `allow_all`. */
function validatePolicySettings(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '`policy` must be a map: { default_mode: risk | allow_all }.', severity: 'error' });
    return;
  }
  if (node.default_mode === undefined) return;
  const mode = typeof node.default_mode === 'string' ? node.default_mode.trim().toLowerCase() : '';
  if (mode !== 'risk' && mode !== 'allow_all') {
    issues.push({ path: `${path}.default_mode`, message: `must be risk or allow_all (got "${mode || 'unset'}").`, severity: 'error' });
  }
}

/** `approvals.ttl`: how long a held call waits. A bad value only means the 24 h default applies. */
function validateApprovals(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  const warn = (at: string, message: string): void => void issues.push({ path: at, message, severity: 'warning' });
  if (!isTable(node)) return warn(path, '`approvals` must be a map: { ttl }. It is ignored.');
  if (node.ttl !== undefined && !(typeof node.ttl === 'string' && /^\d+[mhd]$/.test(node.ttl.trim()))) {
    warn(`${path}.ttl`, 'must be an integer and m, h or d, such as 30m, 4h or 7d. The 24h default applies.');
  }
}

/** The warning for one rewritten deprecated shape. */
function deprecationIssue({ id, path }: AppliedFix): ManifestIssue {
  const summary = DEPRECATIONS.find((d) => d.id === id)?.summary ?? id;
  return { path, message: `Deprecated: ${summary} \`kortix validate --fix\` rewrites it.`, severity: 'warning', fix: id };
}

/**
 * One file's deprecation warnings, with that file's own line and column. A
 * caller that validates a merged document (`imports:`) adds these per file:
 * the merged document is already in the latest shape.
 */
export function deprecationIssues(text: string): ManifestIssue[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return [];
  const issues = applyDeprecations(doc).map(deprecationIssue);
  locateIssues(text, issues);
  return issues;
}

/** The current manifest reference, named in every retired-format error. */
export const MANIFEST_DOCS_URL = 'https://kortix.com/docs/developers#kortixyaml-reference';

/**
 * `kortix_version` is obsolete. `3` is the deprecation `drop-kortix-version`.
 * `1` and `2` are the legacy formats: one warning, and the body is left to the
 * converter (`./legacy.ts`), which needs the files the manifest points at. Any
 * other value is one error. Returns whether to validate the body.
 */
function validateVersionKey(value: unknown, issues: ManifestIssue[]): boolean {
  // `3` is the deprecation `drop-kortix-version`.
  if (value === undefined || value === null || value === 3) return true;
  // A legacy format still works: a reader converts it with the files it points at (`./legacy.ts`).
  const legacy = legacyFormatOf({ kortix_version: value });
  if (legacy) {
    issues.push({ path: 'kortix_version', message: legacyFormatMessage(legacy), severity: 'warning', fix: 'legacy-format' });
    return false;
  }
  issues.push({
    path: 'kortix_version',
    message: `\`kortix_version: ${JSON.stringify(value)}\` is not a format Kortix knows. kortix.yaml has no version: delete the line (${MANIFEST_DOCS_URL}).`,
    severity: 'error',
  });
  return false;
}

export function validateProject(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return; // optional
  if (!isTable(node)) {
    issues.push({ path, message: '`project` must be a map.', severity: 'error' });
    return;
  }
  expectStringOrAbsent(node.name, `${path}.name`, issues);
  expectStringOrAbsent(node.description, `${path}.description`, issues);
}

export function validateEnv(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '`env` must be a map.', severity: 'error' });
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
        message: `Unknown \`env\` key "${key}". Expected one of: required, optional.`,
        severity: 'warning',
      });
    }
  }
}

/**
 * Validate the `[sandbox]` namespace. The image definitions live under
 * `[[sandbox.templates]]` (array of tables). The `[sandbox]` table itself
 * carries no direct image keys — those belonged to the removed singular
 * `[sandbox]` table, so any that linger are flagged as legacy.
 */
export function validateSandbox(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({
      path,
      message: '`sandbox` must be a map holding a `sandbox.templates` list.',
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
      message: `Image keys set on \`sandbox\` itself (\`${stray.join('`, `')}\`) are not read next to \`sandbox.templates\`. Move them into a \`sandbox.templates\` entry with a slug.`,
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
          message: `\`default\` = "${want}" does not match any \`sandbox.templates\` slug (or the reserved "${RESERVED_SANDBOX_SLUG}").`,
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
        listSectionHint('sandbox.templates'),
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
    // The runtime caps sandbox-template slugs at 64 chars (@kortix/shared/sandbox
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
    // Neither: the template builds the platform base image with its own size and settings.
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
    if (entry.container_runtime !== undefined && typeof entry.container_runtime !== 'boolean') {
      issues.push({
        path: `${where}.container_runtime`,
        message: '`container_runtime` must be true or false.',
        severity: 'error',
      });
    }
    validateResidentialProxy(entry.residential_proxy, `${where}.residential_proxy`, issues);
    if (entry.gpu !== undefined) {
      issues.push({
        path: `${where}.gpu`,
        message: 'GPU specs are not supported in this version. Remove the `gpu` key.',
        severity: 'warning',
      });
    }
  });
}

/**
 * `residential_proxy: true` or `residential_proxy: { country: us }` on a
 * sandbox template. The deployment decides whether it can serve it, which the
 * manifest cannot know: a template that asks for it always gets the warning
 * that its sessions do not start where no residential IP is offered.
 */
function validateResidentialProxy(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (value === undefined || value === false) return;
  if (value !== true && !isTable(value)) {
    issues.push({ path, message: '`residential_proxy` must be true, false, or a table with `country`.', severity: 'error' });
    return;
  }
  if (isTable(value)) {
    for (const key of Object.keys(value)) {
      if (key !== 'country') {
        issues.push({ path: `${path}.${key}`, message: 'unknown key; `residential_proxy` takes `country`.', severity: 'warning' });
      }
    }
    const country = value.country;
    if (country !== undefined && !(typeof country === 'string' && /^[A-Za-z]{2}$/.test(country.trim()))) {
      issues.push({
        path: `${path}.country`,
        message: '`country` must be an ISO 3166-1 alpha-2 code, such as `us` or `de`.',
        severity: 'error',
      });
    }
  }
  issues.push({
    path,
    message:
      "Sessions of this template start only on a deployment that offers a residential IP address (Platinum with the residential proxy on). Elsewhere they fail to start; they never fall back to the sandbox's own address.",
    severity: 'warning',
  });
}

const APP_TYPES = new Set(['static', 'bundle', 'dockerfile', 'oci_image']);
const APP_KEYS = new Set([
  'path', 'type', 'image', 'dockerfile', 'command', 'port', 'root', 'output_dir',
  'install_command', 'build_command', 'spa', 'readiness_path', 'idle_timeout_seconds',
  'always_on', 'uses', 'resources', 'env', 'secrets',
  'processes', 'http_service', 'services', 'mounts', 'vm', 'deploy', 'labels', 'display',
]);
/** An App slug as the Apps API accepts it (`uses` entries name live Apps). */
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validateAppStringMap(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
  validateKey: boolean,
): void {
  if (node === undefined) return;
  if (!isTable(node)) {
    issues.push({ path, message: 'must be a key-to-string map.', severity: 'error' });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const where = `${path}.${key}`;
    if (validateKey && !ENV_NAME_RE.test(key)) {
      issues.push({ path: where, message: 'key must be an uppercase environment variable name.', severity: 'error' });
    }
    // The deploy path refuses these (`resolveAppRuntimeEnvironment` →
    // `assertDestination`). Without the same check here, `validate` passes on a
    // manifest that cannot deploy — which is the one job this command has.
    if (validateKey) {
      const reason = reservedEnvNameReason(key);
      if (reason) {
        issues.push({ path: where, message: `key "${key}" ${reason}`, severity: 'error' });
      }
    }
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ path: where, message: 'must be a non-empty string.', severity: 'error' });
    }
  }
}

const APP_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * The release-config fields of an App block: shapes first, then every rule the
 * deploy engine relies on (`appReleaseConfigIssues`), so `kortix validate`
 * refuses what the API would refuse. A static App runs no machine: skipped.
 */
function validateAppReleaseConfig(block: AppBlockV2, where: string, issues: ManifestIssue[]): void {
  if (block.labels !== undefined && (
    !Array.isArray(block.labels) || block.labels.length > 10
    || block.labels.some((label: unknown) => typeof label !== 'string' || !APP_LABEL_RE.test(label))
  )) {
    issues.push({ path: `${where}.labels`, message: 'must be at most 10 labels of lowercase letters, digits and "-".', severity: 'error' });
  }
  if (block.type === 'static') return;
  const shapes: Array<[string, unknown, (value: unknown) => boolean, string]> = [
    ['processes', block.processes, (v) => isTable(v) && Object.values(v).every((c) => typeof c === 'string'), 'must map a group name to a command string.'],
    ['http_service', block.http_service, isTable, 'must be an object.'],
    ['services', block.services, (v) => Array.isArray(v) && v.every(isTable), 'must be a list of objects.'],
    ['mounts', block.mounts, (v) => Array.isArray(v) && v.every(isTable), 'must be a list of objects.'],
    ['vm', block.vm, (v) => isTable(v) || (Array.isArray(v) && v.every(isTable)), 'must be an object or a list of objects.'],
    ['deploy', block.deploy, isTable, 'must be an object.'],
  ];
  let shapeError = false;
  for (const [key, value, ok, message] of shapes) {
    if (value !== undefined && !ok(value)) {
      issues.push({ path: `${where}.${key}`, message, severity: 'error' });
      shapeError = true;
    }
  }
  if (shapeError) return;
  const input = appReleaseInputFromBlock(block);
  if (!input) return;
  for (const issue of appReleaseConfigIssues(resolveAppReleaseConfig(input))) {
    issues.push({ path: `${where}.${issue.path}`, message: issue.message, severity: 'error' });
  }
}

export function validateAppsV2(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined) return;
  if (!isTable(node)) {
    issues.push({ path, message: 'must be a map keyed by App slug.', severity: 'error' });
    return;
  }
  for (const [slug, value] of Object.entries(node)) {
    const where = `${path}.${slug}`;
    if (!SLUG_RE.test(slug)) {
      issues.push({ path: where, message: 'App key must be a lowercase slug.', severity: 'error' });
    }
    if (!isTable(value)) {
      issues.push({ path: where, message: 'must be an App configuration object.', severity: 'error' });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (key === 'backends') {
        issues.push({ path: `${where}.backends`, message: 'is retired: list the Apps this App uses in `uses`.', severity: 'error' });
      } else if (key === 'monthly_budget_usd') {
        issues.push({ path: `${where}.monthly_budget_usd`, message: 'is retired and ignored: Apps have no budget. Remove it.', severity: 'warning' });
      } else if (key === 'kind') {
        issues.push({
          path: `${where}.kind`,
          message: "is retired: an App's shape comes from its config; see the kortix-apps skill templates.",
          severity: 'warning',
        });
      } else if (!APP_KEYS.has(key)) {
        issues.push({ path: `${where}.${key}`, message: 'is not a supported App field.', severity: 'error' });
      }
    }
    validateAppReleaseConfig(value as AppBlockV2, where, issues);
    if (value.display !== undefined) {
      const displayIssues = appDisplayIssues(value.display, slug);
      for (const issue of displayIssues) {
        issues.push({ path: issue.path ? `${where}.display.${issue.path}` : `${where}.display`, message: issue.message, severity: 'error' });
      }
      const parent = isTable(value.display) ? value.display.parent : undefined;
      if (!displayIssues.some((issue) => issue.path === 'parent') && typeof parent === 'string' && !(parent in node)) {
        issues.push({ path: `${where}.display.parent`, message: 'names no App in this file.', severity: 'error' });
      }
    }
    if (value.uses !== undefined) {
      if (!Array.isArray(value.uses)) {
        issues.push({ path: `${where}.uses`, message: 'must be a list of App slugs.', severity: 'error' });
      } else {
        value.uses.forEach((used: unknown, index: number) => {
          if (typeof used !== 'string' || !APP_SLUG_RE.test(used)) {
            issues.push({ path: `${where}.uses[${index}]`, message: 'must be an App slug: lowercase letters, numbers and single hyphens.', severity: 'error' });
          } else if (used === slug) {
            issues.push({ path: `${where}.uses[${index}]`, message: 'an App cannot use itself.', severity: 'error' });
          }
        });
      }
    }
    const type = value.type;
    if (type !== undefined && (typeof type !== 'string' || !APP_TYPES.has(type))) {
      issues.push({ path: `${where}.type`, message: 'must be static, bundle, dockerfile, or oci_image.', severity: 'error' });
    }
    for (const key of ['path', 'dockerfile', 'root', 'output_dir'] as const) {
      expectRelativePathOrAbsent(value[key], `${where}.${key}`, issues);
    }
    for (const key of ['image', 'install_command', 'build_command'] as const) {
      expectStringOrAbsent(value[key], `${where}.${key}`, issues);
    }
    if (value.command !== undefined) {
      if (!Array.isArray(value.command) || value.command.length === 0 ||
          !value.command.every((item) => typeof item === 'string' && item.length > 0)) {
        issues.push({ path: `${where}.command`, message: 'must be a non-empty string array.', severity: 'error' });
      }
    }
    if (value.port !== undefined) {
      const port = Number(value.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 7331 || port === 8080) {
        issues.push({ path: `${where}.port`, message: 'must be an integer from 1 to 65535, excluding 7331 and 8080.', severity: 'error' });
      }
    }
    if ((type === 'dockerfile' || type === 'oci_image') &&
        (!Array.isArray(value.command) || value.command.length === 0)) {
      if (!issues.some((issue) => issue.path === `${where}.command`)) {
        issues.push({ path: `${where}.command`, message: `is required for ${type} Apps.`, severity: 'error' });
      }
    }
    // The port of the primary service: `port`, or `http_service.internal_port`. A
    // worker-only App (`processes`, no service) serves no port.
    if ((type === 'dockerfile' || type === 'oci_image') && value.port === undefined
        && !(isTable(value.http_service) && value.http_service.internal_port !== undefined)
        && !isTable(value.processes)) {
      issues.push({ path: `${where}.port`, message: `is required for ${type} Apps (or set http_service.internal_port).`, severity: 'error' });
    }
    if (type === 'oci_image' && (typeof value.image !== 'string' || !value.image.trim())) {
      issues.push({ path: `${where}.image`, message: 'is required for oci_image Apps.', severity: 'error' });
    }
    if (value.spa !== undefined && typeof value.spa !== 'boolean') {
      issues.push({ path: `${where}.spa`, message: 'must be a boolean.', severity: 'error' });
    }
    if (value.readiness_path !== undefined &&
        (typeof value.readiness_path !== 'string' || !value.readiness_path.startsWith('/'))) {
      issues.push({ path: `${where}.readiness_path`, message: 'must be an absolute HTTP path.', severity: 'error' });
    }
    expectBoundedIntOrAbsent(value.idle_timeout_seconds, `${where}.idle_timeout_seconds`, { min: 120, max: 86400 }, issues);
    if (value.always_on !== undefined && typeof value.always_on !== 'boolean') {
      issues.push({ path: `${where}.always_on`, message: 'must be true or false.', severity: 'error' });
    }
    if (value.resources !== undefined) {
      if (!isTable(value.resources)) {
        issues.push({ path: `${where}.resources`, message: 'must be an object.', severity: 'error' });
      } else {
        expectBoundedIntOrAbsent(value.resources.cpu, `${where}.resources.cpu`, { min: 1, max: 64 }, issues);
        expectBoundedIntOrAbsent(value.resources.memory_gb, `${where}.resources.memory_gb`, { min: 1, max: 512 }, issues);
        expectBoundedIntOrAbsent(value.resources.disk_gb, `${where}.resources.disk_gb`, { min: 1, max: 2048 }, issues);
        for (const key of Object.keys(value.resources)) {
          if (!['cpu', 'memory_gb', 'disk_gb'].includes(key)) {
            issues.push({ path: `${where}.resources.${key}`, message: 'is not a supported resource field.', severity: 'error' });
          }
        }
      }
    }
    validateAppStringMap(value.env, `${where}.env`, issues, true);
    validateAppStringMap(value.secrets, `${where}.secrets`, issues, true);
  }
}

/**
 * A duration-literal field on a monitor (`interval`, `expect_event_within`).
 * Returns the parsed seconds, or null when the value is absent/rejected.
 */
function validateMonitorDuration(
  value: unknown,
  where: string,
  floorSeconds: number,
  issues: ManifestIssue[],
): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push({
      path: where,
      message: 'must be a duration string like "30s", "5m", "24h", or "7d".',
      severity: 'error',
    });
    return null;
  }
  const seconds = parseDurationSeconds(value);
  if (seconds === null) {
    issues.push({
      path: where,
      message: `"${value}" is not a duration — write a positive integer plus s/m/h/d (e.g. "30s", "5m", "24h").`,
      severity: 'error',
    });
    return null;
  }
  if (seconds < floorSeconds) {
    issues.push({
      path: where,
      message: `must be at least ${floorSeconds}s (got "${value}"); the platform enforces this floor.`,
      severity: 'error',
    });
    return null;
  }
  return seconds;
}

/**
 * `type: event` — the fourth trigger type: "when <app event> happens on
 * <connected app>, run the agent". `connector` names a declared connector,
 * `event` is the provider's event type id, `config` is the provider event
 * config (validated by the provider at subscribe time, not here). `account`
 * optionally names one shared account of that connector by label. `source`
 * optionally names the event source adapter (default: the connector's
 * provider); event ids belong to that adapter. Wiring for
 * the other three types is hard-rejected — a manifest must not claim a
 * schedule the event source never reads.
 *
 * MUST stay in sync with `parseTriggerEntry`'s event branch (apps/api) and
 * `triggerSchema` in ./json-schema.ts.
 */
function validateEventTrigger(
  entry: Record<string, unknown>,
  where: string,
  issues: ManifestIssue[],
): void {
  for (const key of ['connector', 'event'] as const) {
    const value = entry[key];
    if (typeof value !== 'string' || !value.trim()) {
      issues.push({
        path: `${where}.${key}`,
        message: `event triggers must declare \`${key}\`.`,
        severity: 'error',
      });
    }
  }
  if (entry.config !== undefined && !isTable(entry.config)) {
    issues.push({
      path: `${where}.config`,
      message: 'config must be an object.',
      severity: 'error',
    });
  }
  if (entry.account !== undefined && (typeof entry.account !== 'string' || !entry.account.trim())) {
    issues.push({
      path: `${where}.account`,
      message: 'account must be the label of a shared account on the connector.',
      severity: 'error',
    });
  }
  if (entry.source !== undefined && (typeof entry.source !== 'string' || !entry.source.trim())) {
    issues.push({
      path: `${where}.source`,
      message: 'source must be the event source adapter id, such as "composio".',
      severity: 'error',
    });
  }
  for (const key of EVENT_FORBIDDEN_KEYS) {
    if (entry[key] !== undefined) {
      issues.push({
        path: `${where}.${key}`,
        message: 'is not valid on an event trigger — events are driven by the connected app.',
        severity: 'error',
      });
    }
  }
}

/**
 * `type: app` — "when App <app> emits an event, run the agent". The App decides
 * when and why it emits (a poll, a webhook it received, a timer); Kortix only
 * delivers. `app` names an App slug of this project. Narrow by event name with
 * the generic `filter` (`event.name`).
 *
 * MUST stay in sync with `parseTriggerEntry`'s app branch (apps/api) and
 * `triggerSchema` in ./json-schema.ts.
 */
function validateAppTrigger(
  entry: Record<string, unknown>,
  where: string,
  issues: ManifestIssue[],
): void {
  if (typeof entry.app !== 'string' || !APP_SLUG_RE.test(entry.app.trim())) {
    issues.push({
      path: `${where}.app`,
      message: 'app triggers must declare `app`: the slug of an App in this project.',
      severity: 'error',
    });
  }
  for (const key of EVENT_FORBIDDEN_KEYS) {
    if (entry[key] !== undefined) {
      issues.push({
        path: `${where}.${key}`,
        message: 'is not valid on an app trigger — the App decides when to emit.',
        severity: 'error',
      });
    }
  }
}

/**
 * `target: { app, path?, method? }` — a fire calls an App of this project
 * instead of running an agent; `prompt` is then optional.
 * MUST stay in sync with `parseTargetField` (apps/api).
 */
function validateTriggerTarget(entry: Record<string, unknown>, where: string, type: string, issues: ManifestIssue[]): void {
  const target = entry.target;
  if (target === undefined) return;
  const push = (path: string, message: string): void => {
    issues.push({ path: `${where}.target${path}`, message, severity: 'error' });
  };
  if (!isTable(target)) return push('', 'must be a table: { app, path, method }.');
  for (const key of Object.keys(target)) if (!['app', 'path', 'method', 'payload'].includes(key)) push(`.${key}`, 'is not a target field (app, path, method, payload).');
  if (target.payload !== undefined && !isTable(target.payload)) push('.payload', 'must be a table.');
  if (typeof target.app !== 'string' || !APP_SLUG_RE.test(target.app.trim())) push('.app', 'must be the slug of an App in this project.');
  if (target.path !== undefined && (typeof target.path !== 'string' || !target.path.startsWith('/'))) push('.path', 'must be an HTTP path starting with /.');
  if (target.method !== undefined && target.method !== 'POST' && target.method !== 'GET') push('.method', 'must be POST or GET.');
}

const ON_KEYS = ['cron', 'timezone', 'every', 'at', 'webhook', 'event', 'connector', 'account', 'source', 'config', 'app'];
const RUN_KEYS = ['agent', 'prompt', 'session', 'session_key', 'session_id', 'model', 'app', 'path', 'method', 'payload'];

/** The raw `on:` / `run:` objects carry only known keys, and a trigger carries both or neither (trigger-shape.ts). */
function validateOnRunShape(entry: Record<string, unknown>, where: string, issues: ManifestIssue[]): void {
  // A legacy monitor's `run:` is a command string, not this shape.
  if (entry.on === undefined && !isTable(entry.run)) return;
  const push = (at: string, message: string) => issues.push({ path: `${where}.${at}`, message, severity: 'error' });
  if (!isTable(entry.on)) push('on', 'must be a table: what fires the trigger (cron, every, at, webhook, or event).');
  else for (const key of Object.keys(entry.on)) if (!ON_KEYS.includes(key)) push(`on.${key}`, `is not an \`on\` field (${ON_KEYS.join(', ')}).`);
  if (!isTable(entry.run)) push('run', 'must be a table: what a fire runs (agent + prompt, or app + path).');
  else for (const key of Object.keys(entry.run)) if (!RUN_KEYS.includes(key)) push(`run.${key}`, `is not a \`run\` field (${RUN_KEYS.join(', ')}).`);
  if (entry.type !== undefined) push('type', 'is implied by `on`; remove it.');
}

export function validateTriggers(rawNode: unknown, path: string, issues: ManifestIssue[]): void {
  if (rawNode == null) return;
  if (Array.isArray(rawNode)) rawNode.forEach((entry, i) => { if (isTable(entry)) validateOnRunShape(entry, `${path}[${i}]`, issues); });
  // One set of rules for both shapes: an `on:` / `run:` entry is checked as the flat fields it means.
  const node = normalizeTriggerList(rawNode);
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: listSectionHint('triggers'),
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
    if (type === 'monitor') {
      issues.push({ path: `${where}.type`, message: MONITOR_REMOVED_MESSAGE, severity: 'error' });
    } else if (!(TRIGGER_TYPES as readonly string[]).includes(type)) {
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
    // An App target receives the payload, not a prompt.
    if (!promptRaw.trim() && entry.target === undefined) {
      issues.push({
        path: `${where}.prompt`,
        message: 'prompt is required and may not be empty.',
        severity: 'error',
      });
    }
    // Run caps (KRTX-1721): any trigger type, a whole number of at least 1.
    for (const field of ['max_runs_per_hour', 'max_runs_per_day'] as const) {
      const cap = entry[field];
      if (cap !== undefined && !(typeof cap === 'number' && Number.isInteger(cap) && cap >= 1)) {
        issues.push({ path: `${where}.${field}`, message: `${field} must be a whole number of at least 1.`, severity: 'error' });
      }
    }
    // Overlap (KRTX-1721): any trigger type; it acts on fresh session mode only.
    if (entry.overlap !== undefined && entry.overlap !== 'skip' && entry.overlap !== 'allow') {
      issues.push({ path: `${where}.overlap`, message: 'overlap must be "skip" or "allow".', severity: 'error' });
    }
    // The payload filter (KRTX-1721): a value (equals) or one operator per path.
    // A change_request trigger's `filter.base` is the merge's target branch (parseChangeRequestFilter).
    if (entry.filter !== undefined) {
      const parsed = type === 'change_request' ? parseChangeRequestFilter(entry.filter) : parseTriggerFilter(entry.filter);
      if ('error' in parsed) issues.push({ path: `${where}.filter`, message: `${parsed.error}.`, severity: 'error' });
    }
    // The misfire bound (KRTX-1743): cron only, a duration of at least 60s.
    if (entry.max_lateness !== undefined) {
      if (type === 'cron') {
        validateMonitorDuration(entry.max_lateness, `${where}.max_lateness`, TRIGGER_MIN_MAX_LATENESS_SECONDS, issues);
      } else {
        issues.push({ path: `${where}.max_lateness`, message: 'max_lateness is only valid on a cron trigger.', severity: 'error' });
      }
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
      if (entry.every !== undefined) {
        if (cron || runAt) issues.push({ path: `${where}.every`, message: 'declare one of cron, run_at or every.', severity: 'error' });
      } else if (runAt) {
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
          message: 'cron triggers must declare a `cron` expression, an `every` period, or a one-off `run_at`.',
          severity: 'error',
        });
      } else {
        const timezone =
          typeof entry.timezone === 'string' && entry.timezone.trim()
            ? entry.timezone.trim()
            : 'UTC';
        if (isValidIanaTimeZone(timezone)) {
          let parsed = false;
          try {
            new Cron(cron, { paused: true, timezone });
            parsed = true;
          } catch (error) {
            issues.push({
              path: `${where}.cron`,
              message: `invalid cron expression: ${
                error instanceof Error ? error.message : String(error)
              }`,
              severity: 'error',
            });
          }
          const intervalError = parsed ? cronIntervalError(cron, timezone) : null;
          if (intervalError) issues.push({ path: `${where}.cron`, message: intervalError, severity: 'error' });
        }
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
        issues.push({
          path: `${where}.timezone`,
          message: `"${entry.timezone}" is not a valid IANA time zone (e.g. "America/New_York"); the runtime rejects it and the trigger would never fire.`,
          severity: 'error',
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
    } else if (type === 'event') {
      validateEventTrigger(entry, where, issues);
    } else if (type === 'app') {
      validateAppTrigger(entry, where, issues);
    }
    validateTriggerTarget(entry, where, type, issues);
    if (entry.every !== undefined) {
      if (type !== 'cron') issues.push({ path: `${where}.every`, message: `is only valid on a cron trigger (type is "${type}").`, severity: 'error' });
      else validateMonitorDuration(entry.every, `${where}.every`, 60, issues);
    }
    if (type && type !== 'app' && entry.app !== undefined) {
      issues.push({
        path: `${where}.app`,
        message: `is only valid on an app trigger (type is "${type}").`,
        severity: 'error',
      });
    }
    if (type && type !== 'event' && (TRIGGER_TYPES as readonly string[]).includes(type)) {
      for (const key of ['connector', 'account', 'source', 'event', 'config']) {
        if (entry[key] !== undefined) {
          issues.push({
            path: `${where}.${key}`,
            message: `is only valid on an event trigger (type is "${type}").`,
            severity: 'error',
          });
        }
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
    let sessionMode: string | undefined;
    if (sessionModeRaw !== undefined) {
      sessionMode = sessionModeRaw.trim().toLowerCase();
      if (
        sessionMode !== 'fresh' &&
        sessionMode !== 'reuse' &&
        sessionMode !== 'pinned' &&
        sessionMode !== 'keyed'
      ) {
        issues.push({
          path: `${where}.session_mode`,
          message: 'session_mode must be "fresh", "reuse", "pinned", or "keyed".',
          severity: 'error',
        });
      }
    }
    // `pinned` requires a session_id to loop; must not be empty.
    const sessionIdRaw =
      typeof entry.session_id === 'string'
        ? entry.session_id
        : typeof entry.sessionId === 'string'
          ? entry.sessionId
          : undefined;
    if (sessionMode === 'pinned' && !(sessionIdRaw && sessionIdRaw.trim())) {
      issues.push({
        path: `${where}.session_id`,
        message: 'session_mode "pinned" requires a non-empty session_id.',
        severity: 'error',
      });
    }
  });
}

export { validatePolicyRules, validatePolicySettings, validateApprovals };

export function validateConnectors(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: listSectionHint('connectors'),
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
    if (
      entry.name !== undefined &&
      (typeof entry.name !== 'string' || entry.name.trim().length === 0)
    ) {
      issues.push({
        path: `${where}.name`,
        message: 'name must be a non-empty string when provided.',
        severity: 'error',
      });
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
          'provider="computer" is managed automatically when you connect a machine (Computers) — it cannot be declared in kortix.yaml.',
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
    if ((provider === 'pipedream' || provider === 'composio') && typeof entry.app !== 'string') {
      issues.push({
        path: `${where}.app`,
        message: `${provider} connectors require \`app\`.`,
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
    if ((provider === 'openapi' || provider === 'postman') && typeof entry.spec !== 'string') {
      issues.push({
        path: `${where}.spec`,
        message:
          `${provider} connectors need a \`spec\` (URL or repo path); without it the connector fails to materialize.`,
        severity: 'warning',
      });
    }
    if (entry.credential !== undefined) {
      const cm = typeof entry.credential === 'string' ? entry.credential.trim().toLowerCase() : '';
      if (cm === 'per_user') {
        // `per_user` (each member brings their own) was removed 2026-07-05.
        issues.push({
          path: `${where}.credential`,
          message: 'credential "per_user" was removed: connectors are always "shared". Remove this key.',
          severity: 'error',
        });
      } else if (cm !== 'shared') {
        // The runtime (apps/api connectors.ts `parseConnectorEntry`) rejects the whole entry.
        issues.push({
          path: `${where}.credential`,
          message: `credential must be "shared" (got "${cm || 'unset'}").`,
          severity: 'error',
        });
      }
    }
    if (entry.authorization_strategy !== undefined) {
      const strategy =
        typeof entry.authorization_strategy === 'string'
          ? entry.authorization_strategy.trim().toLowerCase()
          : '';
      if (!(CONNECTOR_AUTHORIZATION_STRATEGIES as readonly string[]).includes(strategy)) {
        issues.push({
          path: `${where}.authorization_strategy`,
          message: `authorization_strategy must be one of: ${CONNECTOR_AUTHORIZATION_STRATEGIES.join(', ')} (got "${strategy || 'unset'}").`,
          severity: 'error',
        });
      }
    }
    if (entry.agent_scope !== undefined) {
      // Removed 2026-07: connector access is the agent's own `connectors` grant.
      issues.push({
        path: `${where}.agent_scope`,
        message: 'agent_scope was removed: connector access is set on the agent (`connectors` grant). Remove this key.',
        severity: 'error',
      });
    }
    if ((provider === 'pipedream' || provider === 'composio') && entry.auth !== undefined) {
      issues.push({
        path: `${where}.auth`,
        message:
          `${provider} connectors authenticate via the connected account — [connectors.auth] is ignored at runtime.`,
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
        if (t === 'oauth1' && provider !== 'openapi' && provider !== 'postman' && provider !== 'http') {
          issues.push({
            path: `${where}.auth.type`,
            message: 'auth.type "oauth1" is only supported for openapi/postman/http connectors.',
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
    // Optional `headers` — arbitrary static request headers sent on every call.
    // Same ruleset the runtime parser enforces (shared module), so what merges
    // here is exactly what materializes. Values are plaintext in git: never a
    // credential (that is `auth` + the platform credential store).
    if (entry.headers !== undefined) {
      const parsedHeaders = parseConnectorHeaders(entry.headers);
      if (!parsedHeaders.ok) {
        issues.push({ path: `${where}.headers`, message: `${parsedHeaders.error}.`, severity: 'error' });
      } else if (provider === 'pipedream' || provider === 'composio' || provider === 'channel') {
        issues.push({
          path: `${where}.headers`,
          message:
            `${provider} connectors are called through the platform, not as a raw HTTP request — \`headers\` is ignored at runtime.`,
          severity: 'warning',
        });
      }
    }
    validateConnectorPolicySets(entry, where, issues);
    validatePolicyRules(entry.policies, `${where}.policies`, issues);
  });
}

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
// constants above (GRANTABLE_KORTIX_PERMISSIONS, CONNECTOR_PROVIDERS,
// AGENT_MODES_V2, …), so it imports this module — this re-export must stay
// the LAST statement in the file: json-schema.ts's own top-level code calls
// its builder functions eagerly (`export const KORTIX_V1_JSON_SCHEMA =
// buildManifestV1Schema()`), so by the time this circular import resolves
// (whichever module loads first), every constant it needs must already be
// initialized — which only holds if everything above has already run.
export {
  type JsonSchemaFragment,
  KORTIX_SCHEMA_BASE_URL,
  KORTIX_JSON_SCHEMA,
  buildManifestSchema,
  manifestJsonSchema,
} from './json-schema';
