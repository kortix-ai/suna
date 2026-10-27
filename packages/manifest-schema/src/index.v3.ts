/**
 * `kortix_version` 3 — types + validators.
 *
 * v3 is the canonical manifest: one YAML (split with `imports:`) defines every
 * agent. The project REGISTERS what exists (`skills`, `tools`, `commands`,
 * `extensions`, plus `connectors`, `apps`, `env` names, `sandbox` templates);
 * each AGENT is the only unit of behavior (prompt, model, `permission`) and
 * ENABLES registered things by name. Nothing is project-wide behavior, and
 * nothing harness-specific lives outside `extensions`. Unknown keys are errors.
 *
 * Section validators shared with v1/v2 (project, env, sandbox, triggers,
 * connectors, apps, imports) come from `./index`; the agent-behavior field
 * rules come from `./index.v2`. Both are plain function declarations, so the
 * import cycle with `./index` is safe (see the header of `./index.v2.ts`).
 */

import { validateAgentPolicySetRefs } from './policy-sets';
import {
  AGENT_MODES_V2,
  CODEMODE_VALUES,
  EXTENSION_HARNESSES,
  HARNESS_TOOL_NAMES,
  KORTIX_SKILL_NAMES,
  KORTIX_SKILL_PREFIX,
  KORTIX_TOOL_NAMES,
  PI_PACKAGE_NPM_RE,
  REGISTRY_NAME_MAX,
  REGISTRY_NAME_RE,
  RETIRED_KORTIX_TOOLS,
  SLUG_RE,
  SPACE_HEADER_ITEMS,
  SPACE_SLUG_RE,
  SPACE_TAB_TYPES,
  TOOL_NAME_RE,
} from './constants';

export { SPACE_HEADER_ITEMS, SPACE_TAB_TYPES };
import {
  isTable,
  type ManifestFormat,
  type ManifestIssue,
  validateAppsV2,
  validateConnectors,
  validateEnv,
  validateGrantList,
  validateImports,
  validateKortixPermissionFields,
  validateProject,
  validateSandbox,
  validateTriggers,
} from './index';
import {
  type AgentWorkspaceV2,
  type GrantSetV2,
  type PermissionConfigV2,
  type PiPackageEntryV2,
  resolveGrantSet,
  resolveProjectRepository,
  TOOLS_UNSET_WARNING,
  validateAgentMdFrontmatter,
  validateAppGrantList,
  validateRequiredConnectorFields,
  validateRuntimeV2,
  validateTriggerAgentRefsV2,
} from './index.v2';
import { safeAgentFile, safeRepoPath, safeToolFile } from './layout';
import { BUILTIN_AGENT_KEYS, BUILTIN_AGENTS, type BuiltinAgentKey } from '@kortix/shared/meta-agent';

// ─── Types ─────────────────────────────────────────────────────────────────

export type CodemodeV3 = (typeof CODEMODE_VALUES)[number];

/** `agents.<name>.tools`: `all` (default), `none`, a list, or `{ exclude: [...] }`. */
export type AgentToolsV3 = 'all' | 'none' | string[] | { exclude: string[] };

/**
 * `agents.<name>.skills` and `.extensions`: a grant set, or `{ exclude: [...] }`,
 * which grants every registered name except the listed ones (and any added later).
 */
export type ExcludableGrantSetV3 = GrantSetV2 | { exclude: string[] };

/** `commands.<name>`: a slash command. Exactly one of `prompt` / `prompt_file`. */
export interface CommandV3 {
  description?: string;
  prompt?: string;
  prompt_file?: string;
}

/** `extensions.<name>`: one implementation per harness, at least one. */
export interface ExtensionV3 {
  /**
   * A repo module path, loaded as an OpenCode plugin.
   * @deprecated OpenCode only. OpenCode is sunset (2026-10-23): no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset".
   */
  opencode?: string;
  /** `npm:<name>@<x.y.z>`, a repo path, or pi's `{ source, extensions, … }` form. */
  pi?: PiPackageEntryV2;
}

/** The names `{ exclude: [...] }` leaves out, or null when the value is another form. */
export function excludedNamesV3(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const exclude = (value as { exclude?: unknown }).exclude;
  return Array.isArray(exclude) ? exclude.filter((name): name is string => typeof name === 'string').map((name) => name.trim()) : null;
}

/**
 * The names a v3 grant selects from `universe`: `all` is every name,
 * `{ exclude }` every name but the listed ones, a list as written, and an
 * omitted or `none` grant none.
 */
export function grantedNamesV3(value: unknown, universe: readonly string[]): string[] {
  const excluded = excludedNamesV3(value);
  if (excluded) return universe.filter((name) => !excluded.includes(name));
  const grant = resolveGrantSet(value, 'none');
  return grant === 'all' ? [...universe] : grant === 'none' ? [] : grant;
}

/** One `agents.<name>` entry. Behavior and grants in one block. */
export interface AgentBlockV3 {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  steps?: number;
  options?: Record<string, unknown>;
  color?: string;
  hidden?: boolean;
  prompt?: string;
  prompt_file?: string;
  /** Tool policy. Omitted: `allow`. `skill` and `task` belong to `skills` / `subagents`. */
  permission?: PermissionConfigV2;
  /** Default `true`. */
  enabled?: boolean;
  /** pi's codemode tool. Default `on`. */
  codemode?: CodemodeV3;
  tools?: AgentToolsV3;
  skills?: ExcludableGrantSetV3;
  subagents?: GrantSetV2;
  commands?: GrantSetV2;
  extensions?: ExcludableGrantSetV3;
  connectors?: GrantSetV2;
  connectors_required?: string[];
  secrets?: GrantSetV2;
  apps?: GrantSetV2;
  kortix_permissions?: GrantSetV2;
  workspace?: AgentWorkspaceV2;
  sandbox?: string;
  /** The space the agent works in: a key of the top-level `spaces` map, or a bare slug. Grouping only, never a grant. */
  space?: string;
  network_egress?: { version: 1; default: 'deny'; rules: [] };
}

/** One block of a board tab: a grid card that shows a room, a file, an App,
 *  an embedded page or markdown text. Display only. */
export interface SpaceBlockV3 {
  type: 'chat' | 'artifact' | 'app' | 'iframe' | 'text';
  label?: string;
  /** chat: the name of a project room. */
  room?: string;
  /** artifact: a project file path. */
  path?: string;
  /** app: a Kortix App slug. */
  app?: string;
  /** iframe: a url to embed in a sandboxed frame. */
  url?: string;
  /** text: markdown content. */
  text?: string;
}

export type SpaceTabType = (typeof SPACE_TAB_TYPES)[number];

/** One configured tab of a space. `files` needs `path`, `app` needs `app`,
 *  `artifact` needs `artifact`, `link` needs `url`, `board` carries `blocks`. */
export interface SpaceTabV3 {
  type: SpaceTabType;
  label?: string;
  /** files: a project folder path. */
  path?: string;
  /** app: a Kortix App slug. */
  app?: string;
  /** artifact: an `artifact_id`. */
  artifact?: string;
  /** link: an http(s) url. */
  url?: string;
  /** link: true embeds the page in a sandboxed frame; absent or false shows a link. */
  embed?: boolean;
  /** board: the grid's blocks, in order. */
  blocks?: SpaceBlockV3[];
}

export type SpaceHeaderItem = (typeof SPACE_HEADER_ITEMS)[number];

/** A space is a channel: a room (always the first tab) plus configured tabs.
 *  Agents join it with `agents.<name>.space`. Display and config only: no
 *  behavior, no grants. */
export interface SpaceV3 {
  label?: string;
  description?: string;
  order?: number;
  header?: SpaceHeaderItem[];
  /** The tabs after the room, in order. Absent = the host's default set. */
  tabs?: SpaceTabV3[];
}

/** The v3 manifest after `imports:` are merged. */
export interface ManifestV3 {
  kortix_version: 3;
  default_agent: string;
  /** @deprecated Selects nothing: every new session runs pi. Remove the line. */
  runtime?: 'opencode' | 'pi';
  imports?: string[];
  project?: Record<string, unknown>;
  env?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  skills?: Record<string, string>;
  tools?: Record<string, string>;
  commands?: Record<string, CommandV3>;
  extensions?: Record<string, ExtensionV3>;
  connectors?: Array<Record<string, unknown>>;
  apps?: Record<string, unknown>;
  triggers?: Array<Record<string, unknown>>;
  policy?: Record<string, unknown>;
  policies?: Array<Record<string, unknown>>;
  /** `ttl`: how long a held connector call waits for a decision (`30m`, `4h`, `7d`). */
  approvals?: { ttl?: string };
  /** Spaces (channels): slug → label, description, header and tabs. */
  spaces?: Record<string, SpaceV3>;
  /** Built-in agents the platform injects, keyed by built-in (`my_kortix`). Absent = on; `false` removes it from the project. */
  builtin_agents?: Partial<Record<BuiltinAgentKey, boolean>>;
  agents: Record<string, AgentBlockV3>;
}

// ─── Keys ──────────────────────────────────────────────────────────────────

const TOP_LEVEL_KEYS_V3 = [
  'kortix_version',
  'project',
  'default_agent',
  'runtime',
  'imports',
  'env',
  'sandbox',
  'skills',
  'tools',
  'commands',
  'extensions',
  'connectors',
  'apps',
  'triggers',
  'policy',
  'policies',
  'approvals',
  'spaces',
  'builtin_agents',
  'agents',
] as const;

/** Top-level keys of earlier versions, with what replaces each in v3. */
const RETIRED_TOP_LEVEL_KEYS_V3: Record<string, string> = {
  opencode: 'v3 reads no harness config folder. Declare agents, commands and permissions in kortix.yaml, and plugins under `extensions`.',
  pi: 'v3 reads no harness config folder. Declare pi packages under `extensions` and enable them on an agent.',
  harnesses: 'register each plugin or pi package under `extensions` and enable it on an agent (`agents.<name>.extensions`); set `codemode` on the agent.',
  permission: 'permission is per agent: set `agents.<name>.permission`.',
  channels: 'channel routing is managed in the dashboard; the channel connection is a connector (provider: channel).',
  sandboxes: 'use `sandbox.templates`.',
};

const BEHAVIOR_KEYS_V3 = [
  'description',
  'mode',
  'model',
  'variant',
  'temperature',
  'top_p',
  'steps',
  'options',
  'color',
  'hidden',
  'permission',
] as const;

const AGENT_KEYS_V3 = new Set<string>([
  ...BEHAVIOR_KEYS_V3,
  'prompt',
  'prompt_file',
  'enabled',
  'codemode',
  'tools',
  'skills',
  'subagents',
  'commands',
  'extensions',
  'connectors',
  'connectors_required',
  'policy_sets',
  'secrets',
  'apps',
  'kortix_permissions',
  'workspace',
  'sandbox',
  'space',
  'network_egress',
]);

/** Agent keys of earlier versions, with what replaces each in v3. */
const RETIRED_AGENT_KEYS_V3: Record<string, string> = {
  file: 'v3 has no agent file: set `prompt` or `prompt_file`, and the behavior keys on this block.',
  disable: 'use `enabled: false`.',
  opencode: 'set the behavior keys on this block.',
  harnesses: 'enable registered `extensions` by name, and set `codemode` on this block.',
  env: 'use `secrets`.',
  kortix_cli: 'use `kortix_permissions`.',
  connectors_personal: 'use `connectors_required`.',
  repository_access: 'use `workspace.project_repository`.',
};

const COMMAND_KEYS_V3 = ['description', 'prompt', 'prompt_file'];
const PI_FILTER_KEYS = ['extensions', 'skills', 'prompts', 'themes'];

// ─── Entry point ───────────────────────────────────────────────────────────

/** The registered names agents may grant, collected while validating. */
interface RegistryV3 {
  skills: Set<string>;
  tools: Set<string>;
  commands: Set<string>;
  extensions: Set<string>;
}

/** Validate a v3 manifest body (after `kortix_version` and the format were checked). */
export function validateManifestBodyV3(
  parsed: Record<string, unknown>,
  format: ManifestFormat,
  issues: ManifestIssue[],
): void {
  for (const key of Object.keys(parsed)) {
    if ((TOP_LEVEL_KEYS_V3 as readonly string[]).includes(key)) continue;
    const replacement = RETIRED_TOP_LEVEL_KEYS_V3[key];
    issues.push({
      path: key,
      message: replacement
        ? `"${key}" is not a kortix_version 3 key: ${replacement}`
        : `unknown key "${key}". kortix_version 3 keys: ${TOP_LEVEL_KEYS_V3.join(', ')}.`,
      severity: 'error',
    });
  }

  validateImports(parsed.imports, 'imports', issues);
  validateProject(parsed.project, 'project', issues);
  validateEnv(parsed.env, 'env', issues);
  validateSandbox(parsed.sandbox, 'sandbox', issues, format);
  validateRuntimeV2(parsed.runtime, 'runtime', issues);
  validateTriggers(parsed.triggers, 'triggers', issues, format);
  validateConnectors(parsed.connectors, 'connectors', issues, 2, format);
  validateAppsV2(parsed.apps, 'apps', issues);
  validateSpacesV3(parsed.spaces, 'spaces', issues);

  const registry: RegistryV3 = {
    skills: validateSkillsV3(parsed.skills, 'skills', issues),
    tools: validateToolsV3(parsed.tools, 'tools', issues),
    commands: validateCommandsV3(parsed.commands, 'commands', issues),
    extensions: validateExtensionsV3(parsed.extensions, 'extensions', issues),
  };
  const agents = validateAgentsV3(parsed.agents, 'agents', registry, issues);
  validateBuiltinAgentsV3(parsed.builtin_agents, 'builtin_agents', agents, issues);
  validateDefaultAgentV3(parsed.default_agent, 'default_agent', agents, issues);
  validateTriggerAgentRefsV2(parsed.triggers, 'triggers', [...agents.keys()], issues);
  validateAgentPolicySetRefs(parsed.agents, parsed.connectors, 'agents', issues);
}

/**
 * `spaces`: slug → { label, description, order, header, tabs }. Every pinned
 * tab names its target (`files.path`, `app.app`, `artifact.artifact`,
 * `link.url`); a board carries `blocks`. An agent may name a space that is not
 * declared here: the consumer lists it under its own slug.
 */
function validateSpacesV3(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  const error = (at: string, message: string) => {
    issues.push({ path: at, message, severity: 'error' });
  };
  if (!isTable(node)) return error(path, `\`${path}\` must be a map of space slug to its settings.`);
  const SPACE_KEYS = ['label', 'description', 'order', 'header', 'tabs'];
  const TAB_KEYS = ['type', 'label', 'path', 'app', 'artifact', 'url', 'embed', 'blocks'];
  const BLOCK_TYPES = ['chat', 'artifact', 'app', 'iframe', 'text'];
  const BLOCK_KEYS = ['type', 'label', 'room', 'path', 'app', 'url', 'text'];
  const TARGET: Partial<Record<SpaceTabType, 'path' | 'app' | 'artifact' | 'url'>> = {
    files: 'path',
    app: 'app',
    artifact: 'artifact',
    link: 'url',
  };
  const unknownKeys = (value: Record<string, unknown>, allowed: string[], at: string) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) error(`${at}.${key}`, `unknown key "${key}". Allowed: ${allowed.join(', ')}.`);
    }
  };
  const string = (value: unknown, at: string) => {
    if (value !== undefined && typeof value !== 'string') error(at, 'must be a string.');
  };
  for (const [slug, space] of Object.entries(node)) {
    const where = `${path}.${slug}`;
    if (!SPACE_SLUG_RE.test(slug)) {
      error(where, 'space name must be a slug (lowercase letters, digits, "-" or "_", at most 63 characters).');
    }
    if (!isTable(space)) {
      error(where, `must be a map with optional ${SPACE_KEYS.join(', ')}.`);
      continue;
    }
    unknownKeys(space, SPACE_KEYS, where);
    string(space.label, `${where}.label`);
    string(space.description, `${where}.description`);
    if (space.order !== undefined && typeof space.order !== 'number') error(`${where}.order`, 'must be a number.');
    if (space.header !== undefined) {
      if (!Array.isArray(space.header)) error(`${where}.header`, '`header` must be a list.');
      else
        space.header.forEach((item, i) => {
          if (!(SPACE_HEADER_ITEMS as readonly unknown[]).includes(item)) {
            error(`${where}.header[${i}]`, `must be one of: ${SPACE_HEADER_ITEMS.join(', ')}.`);
          }
        });
    }
    if (space.tabs === undefined) continue;
    if (!Array.isArray(space.tabs)) {
      error(`${where}.tabs`, '`tabs` must be a list.');
      continue;
    }
    space.tabs.forEach((tab, i) => {
      const at = `${where}.tabs[${i}]`;
      if (!isTable(tab)) return error(at, 'a tab must be a map with a `type`.');
      unknownKeys(tab, TAB_KEYS, at);
      if (!(SPACE_TAB_TYPES as readonly unknown[]).includes(tab.type)) {
        return error(`${at}.type`, `tab \`type\` must be one of: ${SPACE_TAB_TYPES.join(', ')}.`);
      }
      for (const key of ['label', 'path', 'app', 'artifact', 'url']) string(tab[key], `${at}.${key}`);
      const target = TARGET[tab.type as SpaceTabType];
      const value = target ? tab[target] : undefined;
      if (target && !(typeof value === 'string' && value.trim())) error(`${at}.${target}`, `a ${String(tab.type)} tab needs \`${target}\`.`);
      if (tab.type === 'link' && typeof tab.url === 'string' && !/^https?:\/\//i.test(tab.url)) {
        error(`${at}.url`, 'must be an http or https url.');
      }
      if (tab.embed !== undefined && typeof tab.embed !== 'boolean') error(`${at}.embed`, 'must be true or false.');
      if (tab.blocks === undefined) return;
      if (!Array.isArray(tab.blocks)) return error(`${at}.blocks`, '`blocks` must be a list.');
      tab.blocks.forEach((block, j) => {
        const bat = `${at}.blocks[${j}]`;
        if (!isTable(block)) return error(bat, 'a block must be a map with a `type`.');
        if (!BLOCK_TYPES.includes(block.type as string)) {
          error(`${bat}.type`, `block \`type\` must be one of: ${BLOCK_TYPES.join(', ')}.`);
        }
        unknownKeys(block, BLOCK_KEYS, bat);
      });
    });
  }
}

// ─── Registries ────────────────────────────────────────────────────────────

/** A map registry's entries, or an error when the value is not a map. */
function registryEntries(node: unknown, path: string, what: string, issues: ManifestIssue[]): Array<[string, unknown]> {
  if (node === undefined || node === null) return [];
  if (!isTable(node)) {
    issues.push({ path, message: `\`${path}\` must be a map of ${what}.`, severity: 'error' });
    return [];
  }
  return Object.entries(node);
}

function validRegistryName(name: string, where: string, issues: ManifestIssue[]): boolean {
  if (REGISTRY_NAME_RE.test(name) && name.length <= REGISTRY_NAME_MAX) return true;
  issues.push({
    path: where,
    message: `"${name}" is not a valid name: lowercase letters and digits in words joined by "-", at most ${REGISTRY_NAME_MAX} characters.`,
    severity: 'error',
  });
  return false;
}

/** `skills`: name → repository folder that holds `SKILL.md`; the folder's name is the skill's name. */
function validateSkillsV3(node: unknown, path: string, issues: ManifestIssue[]): Set<string> {
  const names = new Set<string>(KORTIX_SKILL_NAMES);
  for (const [name, folder] of registryEntries(node, path, 'skill name to folder', issues)) {
    const where = `${path}.${name}`;
    if (!validRegistryName(name, where, issues)) continue;
    if (name.startsWith(KORTIX_SKILL_PREFIX)) {
      issues.push({ path: where, message: `"${KORTIX_SKILL_PREFIX}" names belong to Kortix skills; pick another name.`, severity: 'error' });
      continue;
    }
    const safe = safeRepoPath(folder);
    if (!safe || safe !== String(folder).trim() || safe.slice(safe.lastIndexOf('/') + 1) !== name) {
      issues.push({
        path: where,
        message: `must be the repository folder that holds ${name}/SKILL.md, named after the skill (for example skills/${name}).`,
        severity: 'error',
      });
      continue;
    }
    names.add(name);
  }
  return names;
}

/** `tools`: name → repository module. A Kortix tool's name replaces that tool. */
function validateToolsV3(node: unknown, path: string, issues: ManifestIssue[]): Set<string> {
  const names = new Set<string>([...HARNESS_TOOL_NAMES, ...KORTIX_TOOL_NAMES]);
  for (const [name, file] of registryEntries(node, path, 'tool name to module path', issues)) {
    const where = `${path}.${name}`;
    if ((HARNESS_TOOL_NAMES as readonly string[]).includes(name) || name.startsWith('pty_')) {
      issues.push({ path: where, message: `"${name}" is a harness tool; pick another name.`, severity: 'error' });
      continue;
    }
    if (!TOOL_NAME_RE.test(name) && !(KORTIX_TOOL_NAMES as readonly string[]).includes(name)) {
      issues.push({ path: where, message: 'a tool name is snake_case: a lower-case letter, then letters, digits or `_` (64 characters at most).', severity: 'error' });
      continue;
    }
    if (!safeToolFile(file)) {
      issues.push({ path: where, message: `must be a repository path to a .ts or .js module (for example tools/${name}.ts).`, severity: 'error' });
      continue;
    }
    names.add(name);
  }
  return names;
}

/** `commands`: name → `{ description?, prompt | prompt_file }`. */
function validateCommandsV3(node: unknown, path: string, issues: ManifestIssue[]): Set<string> {
  const names = new Set<string>();
  for (const [name, entry] of registryEntries(node, path, 'command name to command', issues)) {
    const where = `${path}.${name}`;
    if (!validRegistryName(name, where, issues)) continue;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a map with `prompt` or `prompt_file`.', severity: 'error' });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (COMMAND_KEYS_V3.includes(key)) continue;
      issues.push({
        path: `${where}.${key}`,
        message: key === 'agent'
          ? 'a command runs on the agent that enables it (`agents.<name>.commands`).'
          : `unknown command key (allowed: ${COMMAND_KEYS_V3.join(', ')}).`,
        severity: 'error',
      });
    }
    if ((entry.prompt === undefined) === (entry.prompt_file === undefined)) {
      issues.push({ path: where, message: 'set exactly one of `prompt` or `prompt_file`.', severity: 'error' });
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      issues.push({ path: `${where}.description`, message: 'must be a string.', severity: 'error' });
    }
    if (entry.prompt !== undefined && (typeof entry.prompt !== 'string' || !entry.prompt.trim())) {
      issues.push({ path: `${where}.prompt`, message: 'must be a non-empty string.', severity: 'error' });
    }
    if (entry.prompt_file !== undefined && !safeAgentFile(entry.prompt_file)) {
      issues.push({ path: `${where}.prompt_file`, message: 'must be a repository path to a .md file.', severity: 'error' });
    }
    names.add(name);
  }
  return names;
}

/** `extensions`: name → `{ opencode?: module, pi?: source }`, at least one harness. */
function validateExtensionsV3(node: unknown, path: string, issues: ManifestIssue[]): Set<string> {
  const names = new Set<string>();
  for (const [name, entry] of registryEntries(node, path, 'extension name to its harness implementations', issues)) {
    const where = `${path}.${name}`;
    if (!validRegistryName(name, where, issues)) continue;
    if (!isTable(entry)) {
      issues.push({ path: where, message: `must be a map of harness (${EXTENSION_HARNESSES.join(', ')}) to implementation.`, severity: 'error' });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!(EXTENSION_HARNESSES as readonly string[]).includes(key)) {
        issues.push({ path: `${where}.${key}`, message: `unknown harness (allowed: ${EXTENSION_HARNESSES.join(', ')}).`, severity: 'error' });
      }
    }
    if (entry.opencode === undefined && entry.pi === undefined) {
      issues.push({ path: where, message: `set at least one implementation: ${EXTENSION_HARNESSES.join(' or ')}.`, severity: 'error' });
    }
    if (entry.opencode !== undefined && !safeToolFile(entry.opencode)) {
      issues.push({ path: `${where}.opencode`, message: 'must be a repository path to a .ts or .js plugin module.', severity: 'error' });
    }
    if (entry.pi !== undefined) validatePiSourceV3(entry.pi, `${where}.pi`, issues);
    names.add(name);
  }
  return names;
}

/** A pi package source: an exact npm pin or a repository path, alone or in pi's filter form. */
function validatePiSourceV3(value: unknown, where: string, issues: ManifestIssue[]): void {
  const source = isTable(value) ? value.source : value;
  const sourcePath = isTable(value) ? `${where}.source` : where;
  const ok = typeof source === 'string' && (PI_PACKAGE_NPM_RE.test(source) || (!source.startsWith('npm:') && safeRepoPath(source) === source));
  if (!ok) {
    issues.push({
      path: sourcePath,
      message: 'must be an exact npm pin (npm:<name>@<x.y.z>) or a repository path (for example extensions/audit.ts).',
      severity: 'error',
    });
  }
  if (!isTable(value)) return;
  for (const [key, filter] of Object.entries(value)) {
    if (key === 'source') continue;
    if (!PI_FILTER_KEYS.includes(key)) {
      issues.push({ path: `${where}.${key}`, message: `unknown key (allowed: source, ${PI_FILTER_KEYS.join(', ')}).`, severity: 'error' });
    } else if (!Array.isArray(filter) || filter.some((pattern) => typeof pattern !== 'string')) {
      issues.push({ path: `${where}.${key}`, message: 'must be a list of glob patterns.', severity: 'error' });
    }
  }
}

// ─── Agents ────────────────────────────────────────────────────────────────

/** Declared agent name → its `mode` and `enabled`, for cross-references. */
type AgentScanV3 = Map<string, { mode: string; enabled: boolean }>;

function validateAgentsV3(node: unknown, path: string, registry: RegistryV3, issues: ManifestIssue[]): AgentScanV3 {
  const agents: AgentScanV3 = new Map();
  if (!isTable(node) || Object.keys(node).length === 0) {
    issues.push({ path, message: '`agents` must be a map of agent name to agent, with at least one agent.', severity: 'error' });
    return agents;
  }
  for (const [name, entry] of Object.entries(node)) {
    if (!SLUG_RE.test(name)) {
      issues.push({ path: `${path}.${name}`, message: `"${name}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`, severity: 'error' });
      continue;
    }
    const block = isTable(entry) ? entry : {};
    agents.set(name, {
      mode: typeof block.mode === 'string' ? block.mode : 'all',
      enabled: block.enabled !== false,
    });
  }
  for (const [name, entry] of Object.entries(node)) {
    if (agents.has(name)) validateAgentBlockV3(name, entry, `${path}.${name}`, registry, agents, issues);
  }
  return agents;
}

function validateAgentBlockV3(
  name: string,
  entry: unknown,
  where: string,
  registry: RegistryV3,
  agents: AgentScanV3,
  issues: ManifestIssue[],
): void {
  if (!isTable(entry)) {
    issues.push({ path: where, message: 'must be a map of agent keys.', severity: 'error' });
    return;
  }
  for (const key of Object.keys(entry)) {
    if (AGENT_KEYS_V3.has(key)) continue;
    const replacement = RETIRED_AGENT_KEYS_V3[key];
    issues.push({
      path: `${where}.${key}`,
      message: replacement ? `"${key}" is not a kortix_version 3 agent key: ${replacement}` : `unknown agent key "${key}".`,
      severity: 'error',
    });
  }

  // Behavior: the same field rules as a v2 agent `.md` frontmatter.
  const behavior: Record<string, unknown> = {};
  for (const key of BEHAVIOR_KEYS_V3) if (entry[key] !== undefined) behavior[key] = entry[key];
  validateAgentMdFrontmatter(behavior, where, issues);
  if (isTable(entry.permission)) {
    for (const owned of [['skill', 'skills'], ['task', 'subagents']] as const) {
      if (entry.permission[owned[0]] !== undefined) {
        issues.push({ path: `${where}.permission.${owned[0]}`, message: `use \`${owned[1]}\` on the agent instead.`, severity: 'error' });
      }
    }
  }

  if (entry.prompt !== undefined && (typeof entry.prompt !== 'string' || !entry.prompt.trim())) {
    issues.push({ path: `${where}.prompt`, message: 'must be a non-empty string.', severity: 'error' });
  }
  if (entry.prompt_file !== undefined) {
    if (entry.prompt !== undefined) {
      issues.push({ path: `${where}.prompt_file`, message: 'set `prompt` or `prompt_file`, not both.', severity: 'error' });
    } else if (!safeAgentFile(entry.prompt_file)) {
      issues.push({ path: `${where}.prompt_file`, message: 'must be a repository path to a .md file.', severity: 'error' });
    }
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    issues.push({ path: `${where}.enabled`, message: 'must be a boolean.', severity: 'error' });
  }
  if (entry.codemode !== undefined && !(CODEMODE_VALUES as readonly unknown[]).includes(entry.codemode)) {
    issues.push({ path: `${where}.codemode`, message: `must be one of: ${CODEMODE_VALUES.join(', ')}.`, severity: 'error' });
  }
  if (entry.sandbox !== undefined && !(typeof entry.sandbox === 'string' && SLUG_RE.test(entry.sandbox.trim()))) {
    issues.push({ path: `${where}.sandbox`, message: 'must be a sandbox template slug.', severity: 'error' });
  }
  if (entry.space !== undefined && !(typeof entry.space === 'string' && SPACE_SLUG_RE.test(entry.space.trim()))) {
    issues.push({ path: `${where}.space`, message: 'must be a space slug (lowercase letters, digits, "-" or "_", at most 63 characters).', severity: 'error' });
  }
  validateNetworkEgressV3(entry.network_egress, `${where}.network_egress`, issues);

  // Grants of registered things.
  validateToolGrantV3(entry.tools, `${where}.tools`, registry.tools, issues);
  validateNamedGrantV3(entry.skills, `${where}.skills`, 'skills', registry.skills, issues, true);
  validateNamedGrantV3(entry.commands, `${where}.commands`, 'commands', registry.commands, issues);
  validateNamedGrantV3(entry.extensions, `${where}.extensions`, 'extensions', registry.extensions, issues, true);
  const subagents = new Set([...agents].filter(([other, scan]) => other !== name && scan.enabled && scan.mode !== 'primary').map(([other]) => other));
  validateNamedGrantV3(entry.subagents, `${where}.subagents`, 'subagents', subagents, issues);

  // Kortix governance: the v2 rules.
  validateGrantList(entry.connectors, `${where}.connectors`, 'connectors', issues, false, 2);
  validateRequiredConnectorFields(entry, where, issues);
  validateGrantList(entry.secrets, `${where}.secrets`, 'secrets', issues, false, 2);
  validateAppGrantList(entry.apps, `${where}.apps`, issues);
  validateKortixPermissionFields(entry, where, issues, 2);
  if (entry.workspace !== undefined) {
    const repository = resolveProjectRepository({ workspace: entry.workspace });
    if (!repository.ok) issues.push({ path: `${where}.${repository.path}`, message: repository.message, severity: 'error' });
  }
}

/**
 * A grant of registered names: `all`, `none`, or a list where each name is
 * registered. `excludable` also takes `{ exclude: [names] }`.
 */
function validateNamedGrantV3(value: unknown, where: string, label: string, known: Set<string>, issues: ManifestIssue[], excludable = false): void {
  let names: unknown = value;
  if (excludable && isTable(value)) {
    if (Object.keys(value).length !== 1 || !Array.isArray(value.exclude) || value.exclude.some((name) => typeof name !== 'string' || !name.trim())) {
      issues.push({ path: where, message: `${label} must be \`all\`, \`none\`, a list of names, or \`{ exclude: [names] }\`.`, severity: 'error' });
      return;
    }
    names = value.exclude;
  } else {
    const before = issues.length;
    validateGrantList(value, where, label, issues, false, 2);
    if (issues.length !== before) return;
  }
  if (!Array.isArray(names)) return;
  const unknown = names.map((item) => String(item).trim()).filter((item) => !known.has(item));
  if (unknown.length > 0) {
    issues.push({
      path: where,
      message: label === 'subagents'
        ? `not a declared, enabled subagent (mode subagent or all, not this agent): ${unknown.join(', ')}.`
        : `not registered under \`${label}\`: ${unknown.join(', ')}.`,
      severity: 'error',
    });
  }
}

/** `tools`: `all` | `none` | a list | `{ exclude: [...] }`; each name a harness, Kortix or registered tool. */
function validateToolGrantV3(value: unknown, where: string, known: Set<string>, issues: ManifestIssue[]): void {
  if (value === undefined) {
    issues.push({ path: where, message: TOOLS_UNSET_WARNING, severity: 'warning' });
    return;
  }
  if (value === 'all' || value === 'none') return;
  let names: unknown = value;
  if (isTable(value)) {
    if (Object.keys(value).length !== 1 || !Array.isArray(value.exclude)) {
      issues.push({ path: where, message: 'tools must be `all`, `none`, a list of tool names, or `{ exclude: [names] }`.', severity: 'error' });
      return;
    }
    names = value.exclude;
  }
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim())) {
    issues.push({ path: where, message: 'tools must be `all`, `none`, a list of tool names, or `{ exclude: [names] }`.', severity: 'error' });
    return;
  }
  const missing = (names as string[]).map((name) => name.trim()).filter((name) => !known.has(name) && !name.startsWith('pty_'));
  const retired = missing.filter((name) => RETIRED_KORTIX_TOOLS.includes(name));
  const unknown = missing.filter((name) => !RETIRED_KORTIX_TOOLS.includes(name));
  if (retired.length > 0) {
    issues.push({ path: where, message: `removed: ${retired.join(', ')}. Agents reach connectors with the \`kortix connectors\` CLI. Delete these names.`, severity: 'warning' });
  }
  if (unknown.length > 0) {
    issues.push({ path: where, message: `not a harness, Kortix or registered tool: ${unknown.join(', ')}.`, severity: 'error' });
  }
}

function validateNetworkEgressV3(value: unknown, where: string, issues: ManifestIssue[]): void {
  if (value === undefined) return;
  const ok = isTable(value) && value.version === 1 && value.default === 'deny' && Array.isArray(value.rules) &&
    value.rules.length === 0 && Object.keys(value).every((key) => ['version', 'default', 'rules'].includes(key));
  issues.push(ok
    ? { path: where, message: 'declaration only: network egress is not enforced until provider gateway isolation is available.', severity: 'warning' }
    : { path: where, message: 'only version 1 default-deny with empty rules is supported; network egress is not enforced.', severity: 'error' });
}

/**
 * `builtin_agents`: built-in key → on/off. Absent or `true` = on. A built-in's
 * slug (`meta` for My Kortix) is reserved whatever the switch says: the
 * platform keys that slug's grant, prompt and sandbox, so a declared block
 * would never run as written.
 */
function validateBuiltinAgentsV3(node: unknown, path: string, agents: AgentScanV3, issues: ManifestIssue[]): void {
  if (node !== undefined && node !== null) {
    if (!isTable(node)) {
      issues.push({ path, message: `\`${path}\` must be a map of built-in agent to true or false (${BUILTIN_AGENT_KEYS.join(', ')}).`, severity: 'error' });
    } else {
      for (const [key, value] of Object.entries(node)) {
        if (!(BUILTIN_AGENT_KEYS as string[]).includes(key)) {
          issues.push({ path: `${path}.${key}`, message: `unknown built-in agent "${key}". Built-in agents: ${BUILTIN_AGENT_KEYS.join(', ')}.`, severity: 'error' });
        } else if (typeof value !== 'boolean') {
          issues.push({ path: `${path}.${key}`, message: `\`${path}.${key}\` must be true or false.`, severity: 'error' });
        }
      }
    }
  }
  for (const key of BUILTIN_AGENT_KEYS) {
    const { agent, displayName } = BUILTIN_AGENTS[key];
    if (agents.has(agent)) {
      issues.push({ path: `agents.${agent}`, message: `"${agent}" is reserved for ${displayName}, the built-in agent. Rename this agent. To turn ${displayName} off, set \`${path}.${key}: false\`.`, severity: 'error' });
    }
  }
}

function validateDefaultAgentV3(node: unknown, path: string, agents: AgentScanV3, issues: ManifestIssue[]): void {
  const name = typeof node === 'string' ? node.trim() : '';
  const scan = agents.get(name);
  if (!name) {
    issues.push({ path, message: '`default_agent` is required: the name of a declared primary agent.', severity: 'error' });
  } else if (!scan) {
    issues.push({ path, message: `"${name}" is not a declared agent.`, severity: 'error' });
  } else if (!scan.enabled) {
    issues.push({ path, message: `"${name}" has \`enabled: false\`; the default agent must be enabled.`, severity: 'error' });
  } else if (scan.mode === 'subagent') {
    issues.push({ path, message: `"${name}" is a subagent; the default agent has mode ${AGENT_MODES_V2.filter((mode) => mode !== 'subagent').join(' or ')}.`, severity: 'error' });
  }
}
