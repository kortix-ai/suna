/**
 * `kortix_version` 2 — types + validators.
 *
 * Extracted from `./index.ts` (thermo-nuclear-review FIX 1: that file had
 * grown to ~1900 lines; the v2 surface — types plus every v2-only
 * validator — was one cohesive, contiguous, self-contained block). Kept in
 * its own module so `index.ts` doesn't grow without bound as later manifest
 * versions are added — the same instinct that pulled the shared enums out
 * into `constants.ts`.
 *
 * `index.ts` re-exports everything here, so `@kortix/manifest-schema` /
 * `./index` consumers are unaffected by the split — see the re-export block
 * near the top of `index.ts`.
 *
 * Dependency direction: this file imports the small set of leaf helpers it
 * needs (`isTable`, `expectStringOrAbsent`, `validateGrantList`, the
 * `ManifestIssue` type) from `./index`, and every enum/regex from
 * `./constants`. `index.ts` in turn imports this file's v2 dispatch
 * functions (`validateRuntimeV2`, `validateAgentsV2`, `validateDefaultAgentV2`,
 * `rejectChannelsV2`, `validateTriggerAgentRefsV2`) to call from
 * `validateManifestBodyV2` — so this module and `index.ts` import each
 * other. That is safe here (unlike the `index.ts` ⇄ `json-schema.ts` cycle
 * `constants.ts` had to break): none of the cross-imported bindings are
 * touched at module top-level, only inside function bodies that run after
 * the whole module graph has loaded, and every binding this file pulls from
 * `./index` is a plain `function` declaration (hoisted, always initialized)
 * rather than a `const`/class whose initializer could still be mid-cycle.
 * The old cycle broke on exactly that: `json-schema.ts` eagerly evaluated a
 * top-level `const … = buildManifestV1Schema()` that needed a
 * not-yet-initialized cross-cycle binding.
 */

import {
  AGENT_MODES_V2,
  AGENT_THEME_COLORS_V2,
  HEX_COLOR_RE_V2,
  PERMISSION_ACTION_ONLY_KEYS_V2,
  PERMISSION_ACTIONS_V2,
  SLUG_RE,
  V2_RUNTIME_VALUES,
  WORKSPACE_MODES_V2,
} from './constants';
import { MANIFEST_FILENAME_YAML } from './format';
import { expectStringOrAbsent, isTable, type ManifestIssue, validateGrantList } from './index';

// ─── kortix_version 2 types ───────────────────────────────────────────────
//
// v2 unifies identity + governance + runtime behavior into one `agents:` map
// (spec §2.2). These types have no compiler/consumer yet (that's a later PR
// — see AGENT-FIRST spec §2.3) but are exported now so that PR can build on a
// clean, already-reviewed shape instead of re-deriving it from the validator.

/** Full OpenCode `AgentConfig.mode` parity — https://opencode.ai/config.json `$defs.AgentConfig`. */
export type AgentModeV2 = 'primary' | 'subagent' | 'all';

/** Kortix governance field — validated only in this phase; enforcement is Phase 4. */
export type WorkspaceModeV2 = 'runtime' | 'read' | 'branch';

/** Session runtimes. `pi` boots the compiled pi worker (behind the project's
 *  `pi_worker` feature flag); anything else — including absence — keeps the
 *  OpenCode path byte-for-byte. Reserved room for `claude` later. */
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

/**
 * One entry of the v2 `agents:` map — GOVERNANCE ONLY (decision 2026-07-05,
 * "one home per concern"). OpenCode behavior (mode, model, temperature,
 * top_p, steps, variant, color, hidden, permission, and the prompt itself)
 * lives entirely in the agent's native `.kortix/opencode/agents/<name>.md`
 * frontmatter + body — a stock OpenCode agent `.md` is valid as-is, with no
 * Kortix-specific split. The agent NAME is the join between this map key and
 * that `.md` filename; there is no `prompt:`/file-ref field here anymore.
 *
 * Kortix governance (this type) is enforced platform-side (IAM grants,
 * secret scoping) and has no OpenCode representation, except `skills`, which
 * the compiler folds onto the frontmatter's `permission.skill` — see
 * compile-agent-config.ts.
 */
export interface AgentBlockV2 {
  /** Kortix governance: can this agent start a session at all? Default true
   *  when omitted. Compiles to the runtime's `disable` field (inverted,
   *  and only ever forces it ON — a hand-authored `disable: true` in the
   *  agent's own frontmatter still passes through when this is omitted) —
   *  see compile-agent-config.ts. */
  enabled?: boolean;
  /** Sandbox template slug for sessions that start with this agent. */
  sandbox?: string;
  connectors?: GrantSetV2;
  /** Connectors that must resolve before the session starts. Each
   *  entry must also exist in this agent's resolved `connectors` grant. */
  connectors_required?: string[];
  /** @deprecated Input alias for `connectors_required`. Serializers emit only
   *  `connectors_required`. */
  connectors_personal?: string[];
  /** Which project secrets this agent may receive as sandbox env (and read via
   *  the secrets API) — a list of secret IDENTIFIERS (project_secrets.identifier),
   *  NOT raw env-var keys. For a project where every secret's identifier equals
   *  its key (the default/migrated case) this reads exactly like a key list.
   *  'all' (default when omitted) = every secret in the project; 'none'/[] =
   *  none. Two granted identifiers resolving to the same env var key is a
   *  configuration error (ambiguous) — see resolveGrantedSecretEnv. This is the
   *  SOLE authorization gate on agent secret access. */
  secrets?: GrantSetV2;
  /** Which of the project's `.kortix/opencode/skills/*` this agent may invoke —
   *  same grant-set shape as connectors/secrets (names | "all" | "none"), v2
   *  deny-by-default when omitted. Unlike connectors/secrets/kortix_cli (pure
   *  Kortix governance with no runtime representation), `skills` DOES compile
   *  to something OpenCode understands: the runtime compiler
   *  (compile-agent-config.ts) maps it onto the agent's `permission.skill`, so
   *  it's a first-class, cleanly-named governance control instead of
   *  something the author has to express by hand-writing glob rules in the
   *  agent's own frontmatter. */
  skills?: GrantSetV2;
  kortix_cli?: GrantSetV2;
  workspace?: WorkspaceModeV2;
}

/**
 * An agent BORROWED from another space: `agents.<name>: { from: <slug> }`
 * in a `kortix-<slug>.yaml`. It imports use, not governance — the target must
 * be an agent OWNED by `<slug>` (never itself a reference), and the block may
 * carry no other key in this version (spec 2026-09-06 §2). Grant-set
 * narrowing is a later addendum.
 */
export interface AgentReferenceV2 {
  from: string;
}

/**
 * The body of one `kortix-<slug>.yaml` — a Claude/ChatGPT-style "project"
 * INSIDE a Kortix project. It groups sessions, may pin a default agent, owns
 * the triggers that name it (`triggers[].space`), and declares the agents
 * that are usable only inside it. Identity is the FILENAME, so there is no `slug` key
 * and no `kortix_version` (the root manifest's version applies).
 * Authorization is an IAM object grant (`object_type = 'space'`, closed
 * by default, like agents) and lives server-side — nothing here is a
 * permission.
 */
export interface SpaceFileV2 {
  /** Display name. Defaults to the slug. */
  name?: string;
  description?: string;
  /** Default agent for sessions started inside this space. Must be
   *  usable here (global, owned, or referenced); omit to fall back to
   *  `default_agent`. A default, not a binding: the person may pick any
   *  other agent they hold. */
  agent?: string;
  /** Session visibility inside the space. `private` (default): the
   *  ordinary model — a session is its creator's unless shared. `shared`:
   *  everyone granted the space may open every session in it. */
  sessions?: SpaceSessionsModeV2;
  /** Agents this space OWNS (a full block, same shape as the root's) or
   *  BORROWS from another space (`{ from: <slug> }`). An owned agent is
   *  usable only here and in the spaces that reference it. */
  agents?: Record<string, AgentBlockV2 | AgentReferenceV2>;
}

/** True for a table whose ONLY key is a non-empty `from` — the borrowed-agent
 *  shape. Anything else is an agent block (or a shape error). */
export function isAgentReferenceV2(entry: unknown): entry is AgentReferenceV2 {
  if (!isTable(entry)) return false;
  const keys = Object.keys(entry);
  return (
    keys.length === 1 &&
    keys[0] === 'from' &&
    typeof entry.from === 'string' &&
    entry.from.trim() !== ''
  );
}

/** The one place that knows the space filename convention: a BASENAME
 *  `kortix-<slug>.yaml`, capture group 1 = the slug. `.yaml` only — a v1
 *  (`kortix.toml`) project has no spaces, and `kortix.yaml` itself is
 *  the root manifest, never a space. */
export const SPACE_FILE_RE = new RegExp(
  `^kortix-(${SLUG_RE.source.replace(/^\^/, '').replace(/\$$/, '')})\\.yaml$`,
);

/** The path of `<slug>`'s file inside `dir` (the directory holding the
 *  resolved root manifest; `''` for the repo root). */
export function spaceFilePath(dir: string, slug: string): string {
  const base = `kortix-${slug}.yaml`;
  const prefix = dir.replace(/\/+$/, '');
  return prefix ? `${prefix}/${base}` : base;
}

/** The slug `path` declares, or `null` when its basename is not a space
 *  file (`kortix.yaml`, `kortix-x.yml`, `kortix-Bad.yaml`, …). */
export function spaceSlugFromPath(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  return base.match(SPACE_FILE_RE)?.[1] ?? null;
}

export const SPACE_SESSIONS_MODES_V2 = ['private', 'shared'] as const;
export type SpaceSessionsModeV2 = (typeof SPACE_SESSIONS_MODES_V2)[number];

/** The v2 manifest shape (YAML-only). Other sections keep their v1 shape. */
export interface ManifestV2 {
  kortix_version: 2;
  default_agent: string;
  runtime?: RuntimeV2;
  agents: Record<string, AgentBlockV2>;
  project?: Record<string, unknown>;
  env?: Record<string, unknown>;
  opencode?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  triggers?: Array<Record<string, unknown>>;
  connectors?: Array<Record<string, unknown>>;
  apps?: Record<string, AppBlockV2>;
}

export interface AppResourcesV2 {
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
}

/** Local deployment defaults. The server remains the App control plane. */
export interface AppBlockV2 {
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
  monthly_budget_usd?: number;
  resources?: AppResourcesV2;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
}

/**
 * Resolve a grant-set field to its effective value given the version-specific
 * default for an OMITTED key. v1 defaults an absent grant to `'all'` (adopt-
 * to-govern back-compat); v2 defaults to `'none'` (deny-by-default, spec
 * §2.2/§2.5) — same shape, opposite default. Shape errors (e.g. a garbage
 * string) resolve to `'none'`; `validateGrantList` is what surfaces those as
 * validation errors.
 */
export function resolveGrantSet(value: unknown, defaultWhenOmitted: 'all' | 'none'): GrantSetV2 {
  if (value === undefined || value === null) return defaultWhenOmitted;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '' || v === 'none') return 'none';
    if (v === 'all') return 'all';
    return 'none';
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
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
      message: 'connectors_personal is deprecated in kortix_version 2; use connectors_required.',
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
 * Validate an agent's native `.md` frontmatter as parsed OpenCode behavior
 * (spec §2.2, 2026-07-05 redirect — the ONE home for mode/model/temperature/
 * top_p/steps/variant/color/hidden/permission/description). This is NOT part
 * of `validateManifest`'s pipeline (frontmatter lives in a repo file the
 * validator never reads) — it's exported for the runtime compiler
 * (compile-agent-config.ts), which DOES read the file, to reuse the exact
 * same field rules instead of re-deriving them. A stock OpenCode agent `.md`
 * with none of these fields set is valid as-is (every field optional); the
 * deprecated upstream `tools`/`maxSteps` fields are still flagged so an
 * author gets a pointer instead of a silently-ignored key.
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

  // Deprecated upstream fields — pointer errors, not silent pass-through.
  if (frontmatter.tools !== undefined) {
    issues.push({
      path: `${where}.tools`,
      message: '`tools` is deprecated upstream — use `permission` instead.',
      severity: 'error',
    });
  }
  if (frontmatter.maxSteps !== undefined) {
    issues.push({
      path: `${where}.maxSteps`,
      message: '`maxSteps` is deprecated upstream — use `steps` instead.',
      severity: 'error',
    });
  }
}

/** One entry of the v2 `agents:` map — governance only (spec §2.2, 2026-07-05
 *  redirect). Behavior lives in the agent's own `.md` frontmatter and is
 *  never validated here (this validator has no repo access) — see
 *  `validateAgentMdFrontmatter`. */
function validateAgentBlockV2(entry: unknown, where: string, issues: ManifestIssue[]): void {
  if (!isTable(entry)) {
    issues.push({ path: where, message: 'must be a table/object.', severity: 'error' });
    return;
  }

  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    issues.push({ path: `${where}.enabled`, message: 'must be a boolean.', severity: 'error' });
  }

  if (entry.sandbox !== undefined) {
    const sandbox = typeof entry.sandbox === 'string' ? entry.sandbox.trim() : '';
    if (!sandbox || !SLUG_RE.test(sandbox)) {
      issues.push({
        path: `${where}.sandbox`,
        message: 'sandbox must be a valid template slug.',
        severity: 'error',
      });
    }
  }

  // v1's grant-set name — renamed to `secrets` in v2 (spec §2.2/§2.4).
  if (entry.env !== undefined) {
    issues.push({
      path: `${where}.env`,
      message: 'use `secrets` instead of `env` in kortix_version 2 manifests.',
      severity: 'error',
    });
  }
  // Pre-redirect / pre-refactor shapes: behavioral fields authored on the
  // manifest agent block at all (flat, or nested under the now-removed
  // `opencode:`) — these live ONLY in the agent's `.md` frontmatter now.
  for (const key of MOVED_TO_AGENT_MD_KEYS) {
    if ((entry as Record<string, unknown>)[key] !== undefined) {
      issues.push({
        path: `${where}.${key}`,
        message: `"${key}" is OpenCode behavior — it lives in this agent's own \`.md\` frontmatter now, not in kortix.yaml. Remove ${where}.${key} and set it in the agent's \`.kortix/opencode/agents/<name>.md\` frontmatter instead.`,
        severity: 'error',
      });
    }
  }

  // Kortix governance — same grant-set shape/action rules as v1, reused as-is.
  validateGrantList(entry.connectors, `${where}.connectors`, 'connectors', issues, false, 2);
  validateRequiredConnectorFields(entry, where, issues);
  validateGrantList(entry.secrets, `${where}.secrets`, 'secrets', issues, false, 2);
  // No fixed catalog to check entries against (skill names are project-defined,
  // like connectors) — same shape/validation, no `checkAction`.
  validateGrantList(entry.skills, `${where}.skills`, 'skills', issues, false, 2);
  // v2 clean break: a LEGACY_TOLERATED action is a hard error here, not a
  // warning (see `validateGrantList`'s doc comment).
  validateGrantList(entry.kortix_cli, `${where}.kortix_cli`, 'kortix_cli', issues, true, 2);

  if (entry.workspace !== undefined) {
    const w = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
    if (!(WORKSPACE_MODES_V2 as readonly string[]).includes(w)) {
      issues.push({
        path: `${where}.workspace`,
        message: `workspace must be one of: ${WORKSPACE_MODES_V2.join(', ')} (got "${w || 'unset'}").`,
        severity: 'error',
      });
    }
  }
}

/** Result of scanning the v2 `agents:` map, for cross-validation by callers. */
export interface AgentsV2Scan {
  /** Every validly-named declared agent (disabled or not). */
  names: string[];
  /** The subset of `names` whose block sets `disable: true`. */
  disabledNames: string[];
}

/**
 * `agents:` — the v2 replacement for v1's `[[agents]]` array (spec §2.1/§2.2).
 * Returns the declared agent names (and which of them are disabled) so
 * callers can cross-validate `default_agent` and `triggers[].agent` against
 * them. Dispatch: called from `index.ts`'s `validateManifestBodyV2`.
 */
export function validateAgentsV2(node: unknown, path: string, issues: ManifestIssue[]): AgentsV2Scan {
  const names: string[] = [];
  const disabledNames: string[] = [];
  if (node == null || (isTable(node) && Object.keys(node).length === 0)) {
    issues.push({
      path,
      message: 'kortix_version 2 manifests must declare at least one agent under `agents`.',
      severity: 'error',
    });
    return { names, disabledNames };
  }
  if (Array.isArray(node) || !isTable(node)) {
    issues.push({
      path,
      message:
        '`agents` must be a map of agent name → agent block in kortix_version 2 (the v1 `[[agents]]` array becomes a map).',
      severity: 'error',
    });
    return { names, disabledNames };
  }
  for (const [name, entry] of Object.entries(node)) {
    const where = `${path}.${name}`;
    if (!SLUG_RE.test(name)) {
      issues.push({
        path: where,
        message: `"${name}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
    } else {
      names.push(name);
      if (isTable(entry) && entry.enabled === false) {
        disabledNames.push(name);
      }
    }
    validateAgentBlockV2(entry, where, issues);
  }
  return { names, disabledNames };
}

/** v2 dispatch: called from `index.ts`'s `validateManifestBodyV2`. */
export function validateDefaultAgentV2(
  node: unknown,
  path: string,
  agentNames: string[],
  disabledNames: string[],
  issues: ManifestIssue[],
): void {
  if (node === undefined || node === null) {
    issues.push({
      path,
      message:
        'kortix_version 2 manifests must set `default_agent` — it must always resolve to a declared agent.',
      severity: 'error',
    });
    return;
  }
  if (typeof node !== 'string' || !node.trim()) {
    issues.push({ path, message: 'default_agent must be a non-empty string.', severity: 'error' });
    return;
  }
  const name = node.trim();
  if (!agentNames.includes(name)) {
    issues.push({
      path,
      message: `default_agent "${name}" does not match any declared agent in \`agents\`.`,
      severity: 'error',
    });
  } else if (disabledNames.includes(name)) {
    issues.push({
      path,
      message: `default_agent "${name}" is declared with \`enabled: false\` — a disabled agent can never resolve as the default; the runtime will reject this at session start.`,
      severity: 'error',
    });
  }
}

/** v2 removes `[[channels]]` entirely — channel↔agent routing is live operational state, not git config (spec §2.5). */
export function rejectChannelsV2(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined) return;
  issues.push({
    path,
    message:
      '`channels` is not supported in kortix_version 2 manifests — channel↔agent routing is managed in the dashboard, and the channel connection is expressed as a connector (provider="channel").',
    severity: 'error',
  });
}

/** The keys a `kortix-<slug>.yaml` may carry. Anything else is an error, so a
 *  typo (`agnet:`) cannot silently become "no agent". */
const SPACE_FILE_KEYS_V2 = new Set(['name', 'description', 'agent', 'sessions', 'agents']);

/** Keys this version dropped (2026-09-07). Ignored with a warning rather than
 *  rejected: a file written when they were valid must not become unparseable,
 *  which would take its sessions and its owned agents down with it. */
const REMOVED_SPACE_FILE_KEYS_V2 = new Set(['instructions', 'context']);

/** The agents one space file declares: the ones it OWNS (a block) and the
 *  ones it BORROWS (`{ from }`). Cross-file checks run on these — see
 *  `validateManifestSetV2`. */
export interface SpaceFileAgentsV2 {
  owned: string[];
  referenced: Array<{ name: string; from: string }>;
}

/**
 * One `kortix-<slug>.yaml` — SHAPE ONLY (spec 2026-09-06 §3). Everything that
 * needs to see another file (`from` targets, duplicate agent names, whether
 * `agent:` is usable here) is `validateManifestSetV2`'s job.
 *
 * `opts.path` prefixes every issue path with the file it came from
 * (`kortix-marketing.yaml:agents.writer`), so a set-wide report says which
 * file each issue belongs to; without it the field path stands alone.
 */
export function validateSpaceFileV2(
  raw: unknown,
  slug: string,
  issues: ManifestIssue[],
  opts?: { path?: string },
): SpaceFileAgentsV2 {
  const file = opts?.path?.trim() ?? '';
  const at = (field: string) => (field ? (file ? `${file}:${field}` : field) : file || slug);
  const result: SpaceFileAgentsV2 = { owned: [], referenced: [] };

  if (!SLUG_RE.test(slug)) {
    issues.push({
      path: at(''),
      message: `"${slug}" is not a valid space slug (lowercase letters, digits, dashes, underscores).`,
      severity: 'error',
    });
  }

  if (!isTable(raw)) {
    issues.push({
      path: at(''),
      message: 'a space file must be a table of space fields (use `{}` for an empty one).',
      severity: 'error',
    });
    return result;
  }

  if (raw.kortix_version !== undefined) {
    issues.push({
      path: at('kortix_version'),
      message:
        "a space file carries no `kortix_version` — the root manifest's version applies (and must be 2).",
      severity: 'error',
    });
  }
  for (const key of Object.keys(raw)) {
    if (key === 'kortix_version' || SPACE_FILE_KEYS_V2.has(key)) continue;
    if (REMOVED_SPACE_FILE_KEYS_V2.has(key)) {
      issues.push({
        path: at(key),
        message: `"${key}" is no longer a space field and is ignored — delete it.`,
        severity: 'warning',
      });
      continue;
    }
    issues.push({
      path: at(key),
      message: `"${key}" is not a space field (allowed: ${[...SPACE_FILE_KEYS_V2].join(', ')}).`,
      severity: 'error',
    });
  }

  expectStringOrAbsent(raw.name, at('name'), issues);
  expectStringOrAbsent(raw.description, at('description'), issues);

  if (
    raw.sessions !== undefined &&
    !(SPACE_SESSIONS_MODES_V2 as readonly unknown[]).includes(raw.sessions)
  ) {
    issues.push({
      path: at('sessions'),
      message: `sessions must be one of ${SPACE_SESSIONS_MODES_V2.map((m) => `"${m}"`).join(', ')}.`,
      severity: 'error',
    });
  }

  if (raw.agent !== undefined && raw.agent !== null) {
    const agent = typeof raw.agent === 'string' ? raw.agent.trim() : '';
    if (!agent) {
      issues.push({
        path: at('agent'),
        message:
          'agent must be a non-empty string naming an agent usable in this space; omit it to fall back to `default_agent`.',
        severity: 'error',
      });
    }
  }

  if (raw.agents !== undefined && raw.agents !== null) {
    validateSpaceAgentsV2(raw.agents, at('agents'), at, result, issues);
  }

  return result;
}

/** `kortix-<slug>.yaml` → `agents:` — the same name→block map the root uses,
 *  plus the `{ from: <slug> }` reference form. */
function validateSpaceAgentsV2(
  node: unknown,
  path: string,
  at: (field: string) => string,
  result: SpaceFileAgentsV2,
  issues: ManifestIssue[],
): void {
  if (Array.isArray(node) || !isTable(node)) {
    issues.push({
      path,
      message:
        '`agents` must be a map of agent name → agent block, or → `{ from: <space> }` to borrow one.',
      severity: 'error',
    });
    return;
  }
  for (const [name, entry] of Object.entries(node)) {
    const where = at(`agents.${name}`);
    if (!SLUG_RE.test(name)) {
      issues.push({
        path: where,
        message: `"${name}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
      continue;
    }
    // `from` present at all ⇒ the author meant a reference; validate it as one
    // rather than as a block with an unknown key.
    if (isTable(entry) && 'from' in entry) {
      const extra = Object.keys(entry).filter((key) => key !== 'from');
      if (extra.length > 0) {
        issues.push({
          path: where,
          message: `a reference may carry no other key in this version (remove: ${extra.join(', ')}); declare the agent here to give it its own governance.`,
          severity: 'error',
        });
        continue;
      }
      if (typeof entry.from !== 'string' || !entry.from.trim()) {
        issues.push({
          path: `${where}.from`,
          message: 'from must be a non-empty string naming the space that owns the agent.',
          severity: 'error',
        });
        continue;
      }
      result.referenced.push({ name, from: entry.from.trim() });
      continue;
    }
    validateAgentBlockV2(entry, where, issues);
    if (isTable(entry)) result.owned.push(name);
  }
}

/** The root manifest plus every `kortix-<slug>.yaml` beside it. */
export interface ManifestSetV2 {
  root: Record<string, unknown>;
  spaces: Array<{ slug: string; path: string; raw: Record<string, unknown> }>;
}

/**
 * The rules no single file can check (spec 2026-09-06 §3): duplicate agent
 * names, `from` targets, and every default that names an agent — `agent:`,
 * `default_agent`, `triggers[].agent` — against the usability rule ("global,
 * owned by the space, or referenced by it"). Shape errors are NOT
 * repeated here; run `validateManifest` on the root and
 * `validateSpaceFileV2` on each file for those.
 */
export function validateManifestSetV2(set: ManifestSetV2, issues: ManifestIssue[]): void {
  const rootAgents = set.root?.agents;
  const globals = isTable(rootAgents)
    ? Object.keys(rootAgents).filter((name) => SLUG_RE.test(name))
    : [];

  const scratch: ManifestIssue[] = [];
  const byPath = new Map<string, string>(); // slug → the file that declared it
  const files: Array<{
    slug: string;
    path: string;
    raw: Record<string, unknown>;
    agents: SpaceFileAgentsV2;
  }> = [];
  for (const entry of set.spaces) {
    const declared = byPath.get(entry.slug);
    if (declared !== undefined) {
      issues.push({
        path: entry.path,
        message: `space "${entry.slug}" is already declared in ${declared} — one file per space.`,
        severity: 'error',
      });
      continue;
    }
    byPath.set(entry.slug, entry.path);
    files.push({
      ...entry,
      agents: validateSpaceFileV2(entry.raw, entry.slug, scratch, { path: entry.path }),
    });
  }

  // 1. Agent names are project-unique across the root and every file.
  const declaredIn = new Map<string, string>(globals.map((name) => [name, MANIFEST_FILENAME_YAML]));
  for (const f of files) {
    for (const name of f.agents.owned) {
      const declared = declaredIn.get(name);
      if (declared !== undefined) {
        issues.push({
          path: `${f.path}:agents.${name}`,
          message: `agent "${name}" is already declared in ${declared} — agent names are unique across the root manifest and every space file.`,
          severity: 'error',
        });
        continue;
      }
      declaredIn.set(name, f.path);
    }
  }

  const ownedBy = new Map(files.map((f) => [f.slug, f.agents.owned]));
  /** The usability rule: global, owned here, or referenced here. */
  const usableIn = (slug: string): string[] => {
    const f = files.find((entry) => entry.slug === slug);
    if (!f) return globals;
    return [...globals, ...f.agents.owned, ...f.agents.referenced.map((ref) => ref.name)];
  };

  // 2. Every `from` names another space that OWNS that agent.
  for (const f of files) {
    for (const ref of f.agents.referenced) {
      const where = `${f.path}:agents.${ref.name}.from`;
      if (ref.from === f.slug) {
        issues.push({
          path: where,
          message: `a space cannot reference itself — declare "${ref.name}" here, or borrow it from another space.`,
          severity: 'error',
        });
      } else if (!byPath.has(ref.from)) {
        issues.push({
          path: where,
          message: `from "${ref.from}" does not match any space — expected ${spaceFilePath('', ref.from)}.`,
          severity: 'error',
        });
      } else if (!ownedBy.get(ref.from)?.includes(ref.name)) {
        issues.push({
          path: where,
          message: `space "${ref.from}" does not declare an agent named "${ref.name}" — a reference must name an agent OWNED there, never a global agent or another reference.`,
          severity: 'error',
        });
      }
    }
  }

  // 3. `agent:` must be usable in its own space.
  for (const f of files) {
    const agent = typeof f.raw.agent === 'string' ? f.raw.agent.trim() : '';
    if (!agent) continue;
    if (!usableIn(f.slug).includes(agent)) {
      issues.push({
        path: `${f.path}:agent`,
        message: `agent "${agent}" is not usable in space "${f.slug}" — it must be a global agent, declared in ${f.path}, or borrowed there with \`{ from: <space> }\`.`,
        severity: 'error',
      });
    }
  }

  // 4. `default_agent` must be global. An UNDECLARED name is the root
  //    validator's error (`validateDefaultAgentV2`); this adds the pointed
  //    one it cannot produce — the name IS declared, just not globally.
  const defaultAgent =
    typeof set.root?.default_agent === 'string' ? set.root.default_agent.trim() : '';
  if (defaultAgent && !globals.includes(defaultAgent)) {
    const owner = files.find((f) => f.agents.owned.includes(defaultAgent));
    if (owner) {
      issues.push({
        path: 'default_agent',
        message: `default_agent "${defaultAgent}" is owned by space "${owner.slug}" (${owner.path}) — the project default must be a global agent declared in ${MANIFEST_FILENAME_YAML}.`,
        severity: 'error',
      });
    }
  }

  // 5. Triggers: the space must exist, and the agent must be usable in it.
  const triggers = set.root?.triggers;
  validateTriggerSpaceRefsV2(triggers, 'triggers', [...byPath.keys()], issues);
  if (Array.isArray(triggers)) {
    triggers.forEach((entry, i) => {
      if (!isTable(entry)) return;
      const agent = typeof entry.agent === 'string' ? entry.agent.trim() : '';
      if (!agent) return;
      const slug = typeof entry.space === 'string' ? entry.space.trim() : '';
      if (!slug) {
        // A project-level trigger may use global agents only. As with
        // `default_agent`, an undeclared name is the root validator's error.
        const owner = files.find((f) => f.agents.owned.includes(agent));
        if (owner && !globals.includes(agent)) {
          issues.push({
            path: `triggers[${i}].agent`,
            message: `agent "${agent}" is owned by space "${owner.slug}" (${owner.path}) — a trigger with no \`space\` may use global agents only.`,
            severity: 'error',
          });
        }
        return;
      }
      // An undeclared space is already reported above.
      if (!byPath.has(slug)) return;
      if (!usableIn(slug).includes(agent)) {
        issues.push({
          path: `triggers[${i}].agent`,
          message: `agent "${agent}" is not usable in space "${slug}" — it must be a global agent, declared in ${byPath.get(slug)}, or borrowed there with \`{ from: <space> }\`.`,
          severity: 'error',
        });
      }
    });
  }
}

/** v2 moves every space into its own file — an inline `spaces:` map
 *  is an error that names the convention (spec 2026-09-06 §2). Nothing
 *  shipped with the map, so there is no migration. */
export function rejectSpacesV2(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined) return;
  issues.push({
    path,
    message:
      '`spaces` is not a manifest key — each space lives in its own `kortix-<slug>.yaml` file beside kortix.yaml, one file per space.',
    severity: 'error',
  });
}

/**
 * v2 cross-validation: a trigger's `space` (if set) must name a declared
 * space. Mirrors `validateTriggerAgentRefsV2`.
 */
export function validateTriggerSpaceRefsV2(
  node: unknown,
  path: string,
  spaceNames: string[],
  issues: ManifestIssue[],
): void {
  if (!Array.isArray(node)) return;
  node.forEach((entry, i) => {
    if (!isTable(entry)) return;
    // `subproject:` is this key's pre-2026-09-07 spelling. A manifest written
    // before the rename keeps working — the trigger loader reads it too
    // (`extractTriggers`) — but say so, because the next write emits `space:`.
    const legacy = entry.space === undefined || entry.space === null;
    const raw = legacy ? entry.subproject : entry.space;
    if (raw === undefined || raw === null) return;
    const where = `${path}[${i}].${legacy ? 'subproject' : 'space'}`;
    if (legacy) {
      issues.push({
        path: where,
        message: '`subproject` was renamed to `space` — rename the key (it is still read for now).',
        severity: 'warning',
      });
    }
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || !spaceNames.includes(name)) {
      issues.push({
        path: where,
        message: `space "${String(raw)}" does not match any declared space.`,
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
 *
 * A trigger that carries a `space` is SKIPPED here: its agent may be one
 * the space owns or borrows, which lives in a file this validator never
 * sees. `validateManifestSetV2` checks those against the usability rule.
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
    if (typeof entry.space === 'string' && entry.space.trim()) return;
    // Same skip for the legacy spelling — see `validateTriggerSpaceRefsV2`.
    if (typeof entry.subproject === 'string' && entry.subproject.trim()) return;
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
    if (!agentNames.includes(name)) {
      issues.push({
        path: where,
        message: `agent "${name}" does not match any declared agent in \`agents\`; omit it to fall back to \`default_agent\`.`,
        severity: 'error',
      });
    }
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
