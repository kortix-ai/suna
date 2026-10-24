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
  TOOL_NAME_RE,
} from './constants';
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
  resolveProjectRepository,
  validateAgentMdFrontmatter,
  validateAppGrantList,
  validateRequiredConnectorFields,
  validateRuntimeV2,
  validateTriggerAgentRefsV2,
} from './index.v2';
import { safeAgentFile, safeRepoPath, safeToolFile } from './layout';

// ─── Types ─────────────────────────────────────────────────────────────────

export type CodemodeV3 = (typeof CODEMODE_VALUES)[number];

/** `agents.<name>.tools`: `all` (default), `none`, a list, or `{ exclude: [...] }`. */
export type AgentToolsV3 = 'all' | 'none' | string[] | { exclude: string[] };

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
  skills?: GrantSetV2;
  subagents?: GrantSetV2;
  commands?: GrantSetV2;
  extensions?: GrantSetV2;
  connectors?: GrantSetV2;
  connectors_required?: string[];
  secrets?: GrantSetV2;
  apps?: GrantSetV2;
  kortix_permissions?: GrantSetV2;
  workspace?: AgentWorkspaceV2;
  sandbox?: string;
  /** Classification group for the dashboard (Engineering, Marketing…). Display-only, optional; a slug matching a key in the top-level `domains` map, or a bare name. Agents with no domain fall into a default group in the consumer. */
  domain?: string;
  network_egress?: { version: 1; default: 'deny'; rules: [] };
}

/** One tab of a Space (a configurable channel, MS-Teams style). Each tab
 *  surfaces one thing inside the space: a chat room (a shared durable session),
 *  an artifact (a Files/Drive path — doc or html page), or an app (a Kortix App
 *  slug). Display/config only; the running instance is resolved at render. */
export interface SpaceTabV3 {
  type: 'chat' | 'artifact' | 'app';
  label?: string;
  /** chat: a stable room/channel key → a shared durable session. */
  room?: string;
  /** artifact: a Files/Drive path (doc or html page). */
  path?: string;
  /** app: a Kortix App slug. */
  app?: string;
}

/** A domain is a Space: it groups agents and, optionally, carries a configurable
 *  tab layout (chat/artifact/app). Display + config metadata only — no behavior,
 *  no grants. */
export interface DomainV3 {
  label?: string;
  description?: string;
  order?: number;
  /** The Space's configurable tabs, in order. Agent-writable. */
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
  /** Optional display groups for the dashboard: slug → label/description/order. Data-only. */
  domains?: Record<string, DomainV3>;
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
  'domains',
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
  'secrets',
  'apps',
  'kortix_permissions',
  'workspace',
  'sandbox',
  'domain',
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
  validateDomainsV3(parsed.domains, 'domains', issues);

  const registry: RegistryV3 = {
    skills: validateSkillsV3(parsed.skills, 'skills', issues),
    tools: validateToolsV3(parsed.tools, 'tools', issues),
    commands: validateCommandsV3(parsed.commands, 'commands', issues),
    extensions: validateExtensionsV3(parsed.extensions, 'extensions', issues),
  };
  const agents = validateAgentsV3(parsed.agents, 'agents', registry, issues);
  validateDefaultAgentV3(parsed.default_agent, 'default_agent', agents, issues);
  validateTriggerAgentRefsV2(parsed.triggers, 'triggers', [...agents.keys()], issues);
}

/**
 * `domains`: slug → display metadata (label, description, order). Optional,
 * data-only — it groups agents in the dashboard and carries no behavior. A
 * domain an agent references but does not declare here is allowed (the consumer
 * uses the name as its own label); this only validates the declared map.
 */
function validateDomainsV3(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  if (!isTable(node)) {
    issues.push({ path, message: `\`${path}\` must be a map of domain slug to display metadata.`, severity: 'error' });
    return;
  }
  const DOMAIN_KEYS = new Set(['label', 'description', 'order', 'tabs']);
  const TAB_TYPES = new Set(['chat', 'artifact', 'app']);
  const TAB_KEYS = new Set(['type', 'label', 'room', 'path', 'app']);
  for (const [slug, value] of Object.entries(node)) {
    const where = `${path}.${slug}`;
    if (!SLUG_RE.test(slug)) {
      issues.push({ path: where, message: 'domain name must be a slug (lowercase letters, digits, "-" or "_").', severity: 'error' });
    }
    if (!isTable(value)) {
      issues.push({ path: where, message: 'must be a map with optional `label`, `description`, `order` and `tabs`.', severity: 'error' });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!DOMAIN_KEYS.has(key)) {
        issues.push({ path: `${where}.${key}`, message: `unknown domain key "${key}". Allowed: label, description, order, tabs.`, severity: 'error' });
      }
    }
    if (value.tabs !== undefined) {
      if (!Array.isArray(value.tabs)) {
        issues.push({ path: `${where}.tabs`, message: '`tabs` must be a list.', severity: 'error' });
      } else {
        value.tabs.forEach((tab, i) => {
          const at = `${where}.tabs[${i}]`;
          if (!isTable(tab)) {
            issues.push({ path: at, message: 'a tab must be a map with a `type`.', severity: 'error' });
            return;
          }
          if (typeof tab.type !== 'string' || !TAB_TYPES.has(tab.type)) {
            issues.push({ path: `${at}.type`, message: 'tab `type` must be one of: chat, artifact, app.', severity: 'error' });
          }
          for (const key of Object.keys(tab)) {
            if (!TAB_KEYS.has(key)) {
              issues.push({ path: `${at}.${key}`, message: `unknown tab key "${key}". Allowed: type, label, room, path, app.`, severity: 'error' });
            }
          }
        });
      }
    }
    if (value.label !== undefined && typeof value.label !== 'string') {
      issues.push({ path: `${where}.label`, message: 'must be a string.', severity: 'error' });
    }
    if (value.description !== undefined && typeof value.description !== 'string') {
      issues.push({ path: `${where}.description`, message: 'must be a string.', severity: 'error' });
    }
    if (value.order !== undefined && typeof value.order !== 'number') {
      issues.push({ path: `${where}.order`, message: 'must be a number.', severity: 'error' });
    }
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
  if (entry.domain !== undefined && !(typeof entry.domain === 'string' && SLUG_RE.test(entry.domain.trim()))) {
    issues.push({ path: `${where}.domain`, message: 'must be a domain slug (lowercase letters, digits, "-" or "_").', severity: 'error' });
  }
  validateNetworkEgressV3(entry.network_egress, `${where}.network_egress`, issues);

  // Grants of registered things.
  validateToolGrantV3(entry.tools, `${where}.tools`, registry.tools, issues);
  validateNamedGrantV3(entry.skills, `${where}.skills`, 'skills', registry.skills, issues);
  validateNamedGrantV3(entry.commands, `${where}.commands`, 'commands', registry.commands, issues);
  validateNamedGrantV3(entry.extensions, `${where}.extensions`, 'extensions', registry.extensions, issues);
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

/** A grant of registered names: `all`, `none`, or a list where each name is registered. */
function validateNamedGrantV3(value: unknown, where: string, label: string, known: Set<string>, issues: ManifestIssue[]): void {
  const before = issues.length;
  validateGrantList(value, where, label, issues, false, 2);
  if (issues.length !== before || !Array.isArray(value)) return;
  const unknown = value.map((item) => String(item).trim()).filter((item) => !known.has(item));
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
  if (value === undefined || value === 'all' || value === 'none') return;
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
