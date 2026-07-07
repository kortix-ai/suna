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

/** The only legal `runtime` today; reserved so `runtime: claude` is a one-line project change later. */
export type RuntimeV2 = 'opencode';

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
  connectors?: GrantSetV2;
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
  apps?: Array<Record<string, unknown>>;
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
      '`channels` is not supported in kortix_version 2 manifests — channel↔agent routing is managed in the dashboard, and the channel integration itself is expressed as a connector (provider="channel").',
    severity: 'error',
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
