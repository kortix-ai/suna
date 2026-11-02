import type { AppDisplay, AppReleaseConfigInput } from '@kortix/shared/app-config';
/**
 * Agent behavior rules and grant types shared by the kortix.yaml body
 * (`./index.v3.ts`): grant sets, permission trees, agent behavior fields,
 * workspace, runtime, apps. The `V2` suffixes are history, not a version.
 *
 * This file and `./index` import each other. That is safe: every binding
 * crossing the cycle is a hoisted `function` declaration used only inside
 * function bodies.
 */
import {
  AGENT_MODES_V2,
  AGENT_THEME_COLORS_V2,
  HARNESS_TOOL_NAMES,
  HEX_COLOR_RE_V2,
  KORTIX_TOOL_NAMES,
  isDefaultOnKortixTool,
  RETIRED_KORTIX_TOOLS,
  kortixToolRef,
  PI_PACKAGE_NAME_RE,
  PI_PACKAGE_NPM_RE,
  PI_PACKAGE_PATH_RE,
  PERMISSION_ACTION_ONLY_KEYS_V2,
  PERMISSION_ACTIONS_V2,
  SLUG_RE,
  selectedKortixTools,
  TOOL_NAME_RE,
  V2_RUNTIME_VALUES,
  WORKSPACE_MODES_V2,
} from './constants';
import { expectStringOrAbsent, isTable, type ManifestIssue, validateGrantList, validateKortixPermissionFields } from './index';
import { safeAgentFile, safeToolFile } from './layout';
import { isMyKortixAgentName } from '@kortix/shared/my-kortix-agent';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Full OpenCode `AgentConfig.mode` parity — https://opencode.ai/config.json `$defs.AgentConfig`. */
export type AgentModeV2 = 'primary' | 'subagent' | 'all';

/** What an agent's sessions get in `/workspace`. */
export interface AgentWorkspaceV2 {
  /** Check out the project repository. Default false. */
  project_repository?: boolean;
}

export type ProjectRepositoryResult =
  | { ok: true; value: boolean; legacyRead: boolean }
  | { ok: false; path: string; message: string };

/**
 * Resolve `agents.<name>.workspace.project_repository`. The legacy string form
 * `workspace: runtime|read|branch` still reads (`branch` = true). An omitted
 * value is false: an agent opts in to the checkout. `legacyRead` is the legacy
 * `workspace: read`.
 */
export function resolveProjectRepository(entry: Record<string, unknown>): ProjectRepositoryResult {
  const workspace = entry.workspace;
  if (workspace === undefined) return { ok: true, value: false, legacyRead: false };
  if (typeof workspace === 'string') {
    const mode = workspace.trim();
    if (!(WORKSPACE_MODES_V2 as readonly string[]).includes(mode)) {
      return {
        ok: false,
        path: 'workspace',
        message: `must be a map ({ project_repository: true|false }) or one of: ${WORKSPACE_MODES_V2.join(', ')} (got "${mode || 'unset'}").`,
      };
    }
    return { ok: true, value: mode === 'branch', legacyRead: mode === 'read' };
  }
  if (!isTable(workspace)) return { ok: false, path: 'workspace', message: 'must be a map ({ project_repository: true|false }).' };
  const extra = Object.keys(workspace).find((key) => key !== 'project_repository');
  if (extra) return { ok: false, path: `workspace.${extra}`, message: 'is not a workspace key (allowed: project_repository).' };
  const value = workspace.project_repository;
  if (value !== undefined && typeof value !== 'boolean') {
    return { ok: false, path: 'workspace.project_repository', message: 'must be a boolean.' };
  }
  return { ok: true, value: value ?? false, legacyRead: false };
}

/** The values `runtime:` accepts. It selects nothing since 2026-10-23: every new
 *  session runs pi. `opencode` validates with a deprecation warning. */
export type RuntimeV2 = 'opencode' | 'pi';

/** `$defs.PermissionActionConfig` in the OpenCode config schema. */
export type PermissionActionV2 = 'ask' | 'allow' | 'deny';

/** `$defs.PermissionRuleConfig`: a bare action, or a glob-pattern → action map. */
export type PermissionRuleV2 = PermissionActionV2 | Record<string, PermissionActionV2>;

/**
 * `$defs.PermissionConfig`: either a bare action applied to everything, or an
 * object keyed by tool/capability. `todowrite`/`question`/`webfetch`/
 * `websearch`/`doom_loop` are action-only (no glob-map form upstream); the
 * rest (including arbitrary passthrough tool names) accept the full rule form.
 */
export interface PermissionConfigObjectV2 {
  read?: PermissionRuleV2;
  edit?: PermissionRuleV2;
  glob?: PermissionRuleV2;
  grep?: PermissionRuleV2;
  list?: PermissionRuleV2;
  bash?: PermissionRuleV2;
  task?: PermissionRuleV2;
  external_directory?: PermissionRuleV2;
  lsp?: PermissionRuleV2;
  skill?: PermissionRuleV2;
  todowrite?: PermissionActionV2;
  question?: PermissionActionV2;
  webfetch?: PermissionActionV2;
  websearch?: PermissionActionV2;
  doom_loop?: PermissionActionV2;
  [tool: string]: PermissionRuleV2 | PermissionActionV2 | undefined;
}

export type PermissionConfigV2 = PermissionActionV2 | PermissionConfigObjectV2;

/**
 * A Kortix grant set as it appears on the wire: an allowlist, or the "all"/
 * "none" sentinels. Distinct from the *resolved default* when the key is
 * omitted entirely — see `resolveGrantSet`.
 */
export type GrantSetV2 = 'all' | 'none' | string[];

export interface AppResourcesV2 {
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
}

/** Local deployment defaults. The server remains the App control plane. */
export interface AppBlockV2 {
  /** The Apps, by slug, this App uses: it may bind to them and mint their sign-in tokens. */
  uses?: string[];
  path?: string;
  type?: 'static' | 'bundle' | 'dockerfile' | 'oci_image';
  image?: string;
  dockerfile?: string;
  command?: string[];
  port?: number;
  root?: string;
  output_dir?: string;
  install_command?: string;
  build_command?: string;
  spa?: boolean;
  readiness_path?: string;
  idle_timeout_seconds?: number;
  /** Run 24/7 (cron jobs, workers, websockets) instead of stopping when idle. */
  always_on?: boolean;
  resources?: AppResourcesV2;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Process groups, group → shell command (`""` = the image's command). */
  processes?: Record<string, string>;
  /** The primary service, on the App's own host. */
  http_service?: AppReleaseConfigInput['http_service'];
  /** More named services, each on `<host>--<name>`. */
  services?: AppReleaseConfigInput['services'];
  /** Persistent volumes: `{ source, destination, initial_size_gb, snapshot_retention_days, processes }`. */
  mounts?: AppReleaseConfigInput['mounts'];
  /** Machine size per process group (`[[vm]]`). */
  vm?: AppReleaseConfigInput['vm'];
  /** `{ strategy: rolling | immediate | bluegreen | canary, release_command }`. */
  deploy?: AppReleaseConfigInput['deploy'];
  /** Free-form labels (e.g. `backend`). */
  labels?: string[];
  /** Where Kortix shows the App: `{ listed, preview: live | none, parent }`. */
  display?: AppDisplay;
}

/**
 * Resolve a grant-set field to its effective value given the version-specific
 * default for an OMITTED key. v1 defaults an absent grant to `'all'` (adopt-
 * to-govern back-compat); v2 defaults to `'none'` (deny-by-default, spec
 * §2.2/§2.5) — same shape, opposite default. Shape errors (e.g. a garbage
 * string) resolve to `'none'`; `validateGrantList` is what surfaces those as
 * validation errors. `"*"`, and any list containing `*`, is `'all'`.
 */
export function resolveGrantSet(value: unknown, defaultWhenOmitted: 'all' | 'none'): GrantSetV2 {
  if (value === undefined || value === null) return defaultWhenOmitted;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '' || v === 'none') return 'none';
    if (v === 'all' || v === '*') return 'all';
    return 'none';
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
    // `*` is a synonym of `all`, alone or beside other entries.
    return items.includes('*') ? 'all' : items;
  }
  return defaultWhenOmitted;
}

function normalizeRequiredConnectorList(
  value: unknown,
  where: string,
  issues: ManifestIssue[],
): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    issues.push({
      path: where,
      message: 'must be an array of connector slugs.',
      severity: 'error',
    });
    return null;
  }

  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push({
        path: `${where}[${index}]`,
        message: 'entries must be non-empty connector slugs.',
        severity: 'error',
      });
      continue;
    }
    const slug = item.trim();
    if (!normalized.includes(slug)) normalized.push(slug);
  }
  return normalized;
}

function equalConnectorSets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((slug) => rightSet.has(slug));
}

/** Validate the required-connector aliases in a v2 agent block. */
export function validateRequiredConnectorFields(
  entry: Record<string, unknown>,
  where: string,
  issues: ManifestIssue[],
): void {
  const canonical = normalizeRequiredConnectorList(
    entry.connectors_required,
    `${where}.connectors_required`,
    issues,
  );
  const legacy = normalizeRequiredConnectorList(
    entry.connectors_personal,
    `${where}.connectors_personal`,
    issues,
  );

  if (entry.connectors_personal !== undefined) {
    issues.push({
      path: `${where}.connectors_personal`,
      message: 'connectors_personal was renamed: use connectors_required.',
      severity: 'warning',
    });
  }

  if (canonical && legacy && !equalConnectorSets(canonical, legacy)) {
    issues.push({
      path: `${where}.connectors_personal`,
      message: 'must match connectors_required when both fields are present.',
      severity: 'error',
    });
    return;
  }

  const required = canonical ?? legacy;
  if (!required?.length) return;

  const connectors = resolveGrantSet(entry.connectors, 'none');
  if (connectors === 'all') return;
  const granted = new Set(connectors === 'none' ? [] : connectors);
  const missing = required.filter((slug) => !granted.has(slug));
  if (missing.length > 0) {
    issues.push({
      path: `${where}.connectors_required`,
      message: `must be a subset of the resolved connectors grant; not granted: ${missing.join(', ')}.`,
      severity: 'error',
    });
  }
}

const PI_PACKAGE_FILTERS = ['extensions', 'skills', 'prompts', 'themes'] as const;
const PI_PACKAGES_MAX = 20;

/** One `harnesses.pi.packages` entry: pi's own settings `packages` shape. */
export type PiPackageEntryV2 = string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] };

function validatePiPackageSource(source: unknown, where: string, issues: ManifestIssue[]): void {
  if (typeof source === 'string' && (PI_PACKAGE_NPM_RE.test(source) || PI_PACKAGE_PATH_RE.test(source))) return;
  issues.push({
    path: where,
    message: `must be an exact npm pin (npm:<name>@<x.y.z>) or a repo path starting with ./ (got ${JSON.stringify(source)}).`,
    severity: 'error',
  });
}

function validatePiExclude(exclude: unknown, where: string, issues: ManifestIssue[]): void {
  if (exclude === undefined || exclude === null) return;
  if (!Array.isArray(exclude)) {
    issues.push({ path: where, message: 'must be a list of package names.', severity: 'error' });
    return;
  }
  exclude.forEach((name, index) => {
    if (typeof name === 'string' && (PI_PACKAGE_NAME_RE.test(name) || PI_PACKAGE_PATH_RE.test(name))) return;
    issues.push({
      path: `${where}[${index}]`,
      message: `must be a package name (pi-web-access, @scope/name) or a ./ repo path as the top-level list writes it; exclude never takes a version (got ${JSON.stringify(name)}).`,
      severity: 'error',
    });
  });
}

/** v2 dispatch: called from `index.ts`'s `validateManifestBodyV2`. */
export function validateRuntimeV2(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  const v = typeof node === 'string' ? node.trim() : '';
  if (!(V2_RUNTIME_VALUES as readonly string[]).includes(v)) {
    issues.push({
      path,
      message: `runtime must be one of: ${V2_RUNTIME_VALUES.join(', ')} (got ${JSON.stringify(node)}).`,
      severity: 'error',
    });
  } else if (v === 'opencode') {
    issues.push({
      path,
      message: 'runtime: opencode is deprecated and has no effect: every new session runs pi. Remove the line.',
      severity: 'warning',
    });
  }
}

function validatePermissionAction(value: unknown, where: string, issues: ManifestIssue[]): void {
  if (typeof value !== 'string' || !(PERMISSION_ACTIONS_V2 as readonly string[]).includes(value)) {
    issues.push({
      path: where,
      message: `must be one of: ${PERMISSION_ACTIONS_V2.join(', ')} (got ${JSON.stringify(value)}).`,
      severity: 'error',
    });
  }
}

/** `PermissionRuleConfig`: a bare action, or a map of glob-pattern → action. */
function validatePermissionRule(value: unknown, where: string, issues: ManifestIssue[]): void {
  if (typeof value === 'string') {
    validatePermissionAction(value, where, issues);
    return;
  }
  if (isTable(value)) {
    for (const [glob, action] of Object.entries(value)) {
      validatePermissionAction(action, `${where}.${glob}`, issues);
    }
    return;
  }
  issues.push({
    path: where,
    message: 'must be an action ("ask" | "allow" | "deny") or a map of glob-pattern to action.',
    severity: 'error',
  });
}

/** The recursive `permission` tree — full OpenCode `PermissionConfig` parity.
 *  Exported so the runtime compiler (compile-agent-config.ts) can reuse it to
 *  validate an agent's `.md` frontmatter `permission` tree — the same shape,
 *  just read from a different source now (native frontmatter, not the
 *  manifest) since the 2026-07-05 "one home per concern" redirect. */
export function validatePermissionConfig(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  if (typeof node === 'string') {
    validatePermissionAction(node, path, issues);
    return;
  }
  if (!isTable(node)) {
    issues.push({
      path,
      message:
        'permission must be an action ("ask" | "allow" | "deny") or a permission object (read, edit, bash, …).',
      severity: 'error',
    });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const where = `${path}.${key}`;
    if ((PERMISSION_ACTION_ONLY_KEYS_V2 as readonly string[]).includes(key)) {
      validatePermissionAction(value, where, issues);
    } else {
      validatePermissionRule(value, where, issues);
    }
  }
}

/**
 * Behavioral fields that live ONLY in an agent's native `.md` frontmatter as
 * of the 2026-07-05 redirect ("one home per concern") — authoring one of
 * these flat on the `agents.<name>` block in kortix.yaml (the pre-redirect
 * `opencode:`-nested shape, or the earlier flat shape before that) is a
 * clear, pointed error rather than a silent no-op. `opencode` itself is
 * included: the nested sub-object this schema version used to require is
 * gone outright, not renamed again.
 */
const MOVED_TO_AGENT_MD_KEYS = [
  'description',
  'model',
  'mode',
  'variant',
  'temperature',
  'top_p',
  'options',
  'color',
  'steps',
  'hidden',
  'prompt',
  'permission',
  'disable',
  'opencode',
] as const;

/**
 * Validate an agent's `.md` frontmatter: its behavior on every harness
 * (spec §2.2, 2026-07-05 redirect — the ONE home for mode/model/temperature/
 * top_p/steps/variant/color/hidden/permission/description). This is NOT part
 * of `validateManifest`'s pipeline (frontmatter lives in a repo file the
 * validator never reads) — it's exported for the runtime compiler
 * (compile-agent-config.ts), which DOES read the file, to reuse the exact
 * same field rules instead of re-deriving them. A stock OpenCode agent `.md`
 * with none of these fields set is valid as-is (every field optional); the
 * retired `tools`/`maxSteps` names are still flagged so an author gets a
 * pointer instead of a silently-ignored key.
 */
export function validateAgentMdFrontmatter(
  frontmatter: Record<string, unknown>,
  where: string,
  issues: ManifestIssue[],
): void {
  expectStringOrAbsent(frontmatter.description, `${where}.description`, issues);
  expectStringOrAbsent(frontmatter.model, `${where}.model`, issues);

  if (frontmatter.mode !== undefined) {
    const m = typeof frontmatter.mode === 'string' ? frontmatter.mode.trim() : '';
    if (!(AGENT_MODES_V2 as readonly string[]).includes(m)) {
      issues.push({
        path: `${where}.mode`,
        message: `mode must be one of: ${AGENT_MODES_V2.join(', ')} (got "${m || 'unset'}").`,
        severity: 'error',
      });
    }
  }

  if (frontmatter.disable !== undefined && typeof frontmatter.disable !== 'boolean') {
    issues.push({ path: `${where}.disable`, message: 'must be a boolean.', severity: 'error' });
  }

  expectStringOrAbsent(frontmatter.variant, `${where}.variant`, issues);

  if (frontmatter.temperature !== undefined && !isFiniteNumber(frontmatter.temperature)) {
    issues.push({ path: `${where}.temperature`, message: 'must be a number.', severity: 'error' });
  }
  if (frontmatter.top_p !== undefined && !isFiniteNumber(frontmatter.top_p)) {
    issues.push({ path: `${where}.top_p`, message: 'must be a number.', severity: 'error' });
  }

  if (frontmatter.hidden !== undefined && typeof frontmatter.hidden !== 'boolean') {
    issues.push({ path: `${where}.hidden`, message: 'must be a boolean.', severity: 'error' });
  }
  if (frontmatter.options !== undefined && !isTable(frontmatter.options)) {
    issues.push({ path: `${where}.options`, message: 'must be an object.', severity: 'error' });
  }

  if (frontmatter.color !== undefined) {
    const ok =
      typeof frontmatter.color === 'string' &&
      (HEX_COLOR_RE_V2.test(frontmatter.color) ||
        (AGENT_THEME_COLORS_V2 as readonly string[]).includes(frontmatter.color));
    if (!ok) {
      issues.push({
        path: `${where}.color`,
        message: `color must be a hex color (e.g. "#7C5CFF") or one of: ${AGENT_THEME_COLORS_V2.join(', ')} (got ${JSON.stringify(frontmatter.color)}).`,
        severity: 'error',
      });
    }
  }

  if (frontmatter.steps !== undefined) {
    const n = frontmatter.steps;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      issues.push({
        path: `${where}.steps`,
        message: 'must be a positive integer.',
        severity: 'error',
      });
    }
  }

  if (frontmatter.permission !== undefined) {
    validatePermissionConfig(frontmatter.permission, `${where}.permission`, issues);
  }

  // Retired field names — pointer errors, not silent pass-through.
  if (frontmatter.tools !== undefined) {
    issues.push({
      path: `${where}.tools`,
      message: '`tools` is not an agent setting — use `permission` instead.',
      severity: 'error',
    });
  }
  if (frontmatter.maxSteps !== undefined) {
    issues.push({
      path: `${where}.maxSteps`,
      message: '`maxSteps` is not an agent setting — use `steps` instead.',
      severity: 'error',
    });
  }
}

/** `agents.<name>.apps` — the grant-set shape rules, plus each entry must be
 *  an App slug (or the `*` wildcard). App slugs are project-defined, so there
 *  is no catalog to check membership against here. */
export function validateAppGrantList(value: unknown, where: string, issues: ManifestIssue[]): void {
  const before = issues.length;
  validateGrantList(value, where, 'apps', issues, false);
  if (issues.length !== before || !Array.isArray(value)) return;
  value.forEach((item, k) => {
    const slug = typeof item === 'string' ? item.trim() : '';
    if (slug !== '*' && !SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}[${k}]`,
        message: `"${slug}" is not a valid App slug (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
    }
  });
}

/**
 * v2 cross-validation: a trigger's `agent` (if set) must name a declared
 * agent, or be omitted to fall back to `default_agent` (spec §2.1, closing
 * trigger seam 7(a)). Layered on top of `validateTriggers`' structural checks,
 * which stay identical between v1 and v2.
 */
export function validateTriggerAgentRefsV2(
  node: unknown,
  path: string,
  agentNames: string[],
  issues: ManifestIssue[],
): void {
  if (!Array.isArray(node)) return;
  node.forEach((entry, i) => {
    if (!isTable(entry) || entry.agent === undefined || entry.agent === null) return;
    const where = `${path}[${i}].agent`;
    if (typeof entry.agent !== 'string' || !entry.agent.trim()) {
      issues.push({
        path: where,
        message: 'agent must be a non-empty string naming a declared agent.',
        severity: 'error',
      });
      return;
    }
    const name = entry.agent.trim();
    // `default` is the runtime's "the default agent" sentinel; `mykortix` (and its old `meta`) is My Kortix.
    if (!agentNames.includes(name) && name !== 'default' && !isMyKortixAgentName(name)) {
      issues.push({
        path: where,
        message: `agent "${name}" does not match any declared agent in \`agents\`; omit it to run My Kortix (\`default_agent\` when My Kortix is off).`,
        severity: 'error',
      });
    }
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ─── Tools ──────────────────────────────────────────────────────────────────

function isKortixTool(name: string): boolean {
  return (KORTIX_TOOL_NAMES as readonly string[]).includes(name);
}

/** The values `tools.<name>` allows. */
function toolValueMessage(name: string): string {
  const module = `a repo-relative path to a .ts or .js module (e.g. \`tools/${name}.ts\`)`;
  if (isKortixTool(name)) return `must be \`kortix:${name}\` (the Kortix tool) or ${module} that replaces it.`;
  return `must be ${module}. \`kortix:<name>\` names a Kortix tool under its own name: ${KORTIX_TOOL_NAMES.map((tool) => `\`${tool}: kortix:${tool}\``).join(', ')}.`;
}

/** An agent without `tools` gets every tool, unlike every other grant (omitted = none). */
export const TOOLS_UNSET_WARNING = 'not set: this agent gets every tool. Write `tools: all`, or list the tools it needs.';

/** `agents.<name>.tools` — see `AgentToolsV2`. */
function validateAgentToolsV2(value: unknown, where: string, issues: ManifestIssue[]): void {
  if (value === undefined) {
    issues.push({ path: where, message: TOOLS_UNSET_WARNING, severity: 'warning' });
    return;
  }
  if (value === 'all' || value === 'none') return;
  const names = (list: unknown, at: string) => {
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || !name.trim())) {
      issues.push({ path: at, message: 'must be a list of tool names.', severity: 'error' });
    }
  };
  if (Array.isArray(value)) return names(value, where);
  if (isTable(value) && 'exclude' in value && Object.keys(value).length === 1 && Array.isArray(value.exclude)) {
    return names(value.exclude, `${where}.exclude`);
  }
  if (!isTable(value) || Object.values(value).some((enabled) => typeof enabled !== 'boolean')) {
    issues.push({ path: where, message: 'tools must be `all`, `none`, a list of tool names, or `{ exclude: [names] }`.', severity: 'error' });
  }
}

