/**
 * The legacy formats, read as the latest shape.
 *
 * Projects created before 2026-10-28 carry `kortix_version: 2` (YAML, agent
 * behavior in each agent's `.md` frontmatter, skills found by folder, an
 * OpenCode config folder) or `kortix.toml` (`kortix_version = 1`). They keep
 * working: a reader converts the file, and the files it points at, into the
 * latest shape in memory. `kortix validate --fix` applies the same conversion
 * to the repository (`changes`), after which the project is on the latest
 * shape for good. Nothing is converted silently on disk.
 *
 * Pure: the repository is a list of file paths plus a `read`. The API reads
 * git, the CLI the filesystem (`convertLegacyManifestAsync` for async reads).
 */

import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { KORTIX_TOOL_NAMES, kortixToolRef, REGISTRY_NAME_RE, selectedKortixTools } from './constants';
import { fixManifestText } from './deprecations';
import { parseManifestText, serializeManifestObject } from './format';
import { AGENTS_DIR, safeAgentFile, safeRepoPath, SKILLS_DIR } from './layout';

type Table = Record<string, unknown>;

/** The repository a conversion reads: every file path, and the text of one file (null when absent). */
export interface LegacyRepo {
  paths: readonly string[];
  read(path: string): string | null;
}

export interface LegacyChange {
  path: string;
  action: 'rewrite' | 'delete';
  /** One line: what changes and why. */
  note: string;
  /** New content for `rewrite`. */
  content?: string;
}

export interface LegacyConversion {
  /** The format the file is in: 1 (`kortix.toml`) or 2. */
  from: 1 | 2;
  /** The manifest in the latest shape. */
  raw: Table;
  /** What `--fix` writes and deletes. The manifest itself is the first change. */
  changes: LegacyChange[];
  /** Repo path → the text a reader uses for it now (agent and command prompts without their frontmatter). */
  overlay: Record<string, string>;
  /** What the latest shape has no place for, with the reason. */
  dropped: string[];
}

const LEGACY_OPENCODE_CONFIG_DIR = '.kortix/opencode';
const OPENCODE_CONFIG_DIR = 'harnesses/opencode';
const BEHAVIOR_KEYS = ['description', 'mode', 'model', 'variant', 'temperature', 'top_p', 'steps', 'options', 'color', 'hidden'];
const KEEP_KEYS = ['enabled', 'connectors', 'connectors_required', 'secrets', 'apps', 'kortix_permissions', 'workspace', 'sandbox', 'network_egress'];
/** The agent block keys the conversion reads; every other key is kept as written. */
const CONVERTED_BLOCK_KEYS = new Set([...KEEP_KEYS, 'file', 'harnesses', 'repository_access', 'disable', 'kortix_cli', 'connectors_personal', 'skills', 'tools']);
const TOP_LEVEL_ORDER = ['project', 'default_agent', 'runtime', 'imports', 'env', 'sandbox', 'skills', 'tools', 'commands', 'extensions', 'connectors', 'apps', 'policy', 'policies', 'approvals', 'agents', 'triggers'];
const AGENT_ORDER = [...BEHAVIOR_KEYS, 'prompt_file', 'permission', 'enabled', 'tools', 'skills', 'subagents', 'commands', 'extensions', 'codemode', 'connectors', 'connectors_required', 'secrets', 'apps', 'kortix_permissions', 'workspace', 'sandbox', 'network_egress'];
const SCHEMA_LINE = '# yaml-language-server: $schema=https://kortix.com/schema/kortix.schema.json';

const table = (value: unknown): Table | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function ordered(object: Table, order: string[]): Table {
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined).sort(([a], [b]) => rank(a) - rank(b)));
}

/** The legacy format a parsed manifest declares, or null for the current one. */
export function legacyFormatOf(raw: unknown): 1 | 2 | null {
  const version = table(raw)?.kortix_version;
  return version === 1 || version === '1' ? 1 : version === 2 || version === '2' ? 2 : null;
}

/** Parse a `kortix.toml`. Throws the TOML syntax error. */
export function parseLegacyToml(text: string): Table {
  return table(parseToml(text)) ?? {};
}

/**
 * `---` frontmatter and the body after it. Frontmatter that is not strict YAML
 * (OpenCode read it leniently) falls back to its top-level `key: value` lines;
 * `loose` says so.
 */
export function splitFrontmatter(text: string): { frontmatter: Table; body: string; loose?: true } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const body = match[2]!.replace(/^\s*\n/, '');
  try {
    return { frontmatter: table(parseYaml(match[1]!)) ?? {}, body };
  } catch {
    const frontmatter: Table = {};
    for (const line of match[1]!.split(/\r?\n/)) {
      const pair = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
      if (!pair || pair[2] === '') continue;
      const value = pair[2]!.replace(/^(['"])(.*)\1$/, '$2');
      frontmatter[pair[1]!] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
    }
    return { frontmatter, body, loose: true };
  }
}

/** JSON with `//` and block comments and trailing commas, as OpenCode reads it. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const string = end.exec(text)?.[0] ?? ch;
      out += string;
      i += string.length - 1;
    } else if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i) - 1;
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i) === -1 ? text.length : text.indexOf('*/', i) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A registry name from a file or package name: `audit.ts` → `audit`, `@a/pi-web` → `pi-web`. */
function registryName(raw: string, taken: Set<string>): string {
  const base = raw.split('/').pop()!.replace(/\.[cm]?[jt]s$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'extension';
  let name = base;
  for (let n = 2; taken.has(name) || !REGISTRY_NAME_RE.test(name); n += 1) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/** `npm:@scope/name@1.2.3` → `@scope/name`; `./path` → `./path`. */
function piPackageKey(entry: unknown): string | null {
  const source = typeof entry === 'string' ? entry : table(entry)?.source;
  if (typeof source !== 'string') return null;
  return /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@.*)?$/.exec(source)?.[1] ?? source;
}

/** A pi source in the latest form: a `./` repo path loses its `./`. */
function piSource(entry: unknown): unknown {
  const fix = (source: unknown) => (typeof source === 'string' && source.startsWith('./') ? source.slice(2) : source);
  const filter = table(entry);
  return filter ? { ...filter, source: fix(filter.source) } : fix(entry);
}

/** A v2 `tools` grant (or an OpenCode `{ name: bool }` map) in the latest form, minus the Kortix tools v2 removed. */
function toolsGrant(value: unknown, removed: string[]): unknown {
  let grant = value;
  const map = table(value);
  if (map && !Array.isArray(map.exclude)) {
    const off = Object.entries(map).filter(([, on]) => on === false).map(([name]) => name);
    grant = off.length > 0 ? { exclude: off } : undefined;
  }
  if (removed.length === 0 || grant === 'none') return grant;
  if (Array.isArray(grant)) return grant.filter((name) => !removed.includes(String(name)));
  const exclude = list(table(grant)?.exclude).map(String);
  return { exclude: [...exclude, ...removed.filter((name) => !exclude.includes(name))] };
}

/** `permission.task` as a `subagents` grant: undefined (none) when it denies every agent. */
function subagentsGrant(task: unknown): unknown {
  if (task === undefined || task === 'allow' || task === 'ask') return 'all';
  if (task === 'deny') return undefined;
  const rules = table(task);
  if (!rules) return 'all';
  const named = Object.entries(rules).filter(([name, action]) => name !== '*' && action !== 'deny').map(([name]) => name);
  if (rules['*'] !== undefined && rules['*'] !== 'deny') return 'all';
  return named.length > 0 ? named : undefined;
}

/** v2 `workspace` / `repository_access`, where an omitted value cloned the repository. */
function projectRepository(block: Table): boolean | undefined {
  if (typeof block.repository_access === 'boolean') return block.repository_access;
  if (block.workspace === 'read') return undefined;
  if (typeof block.workspace === 'string') return block.workspace === 'branch';
  const value = table(block.workspace)?.project_repository;
  return typeof value === 'boolean' ? value : true;
}

/** A manifest object as YAML. The root file carries the schema line. */
export function renderManifest(object: Table, root = true): string {
  let section = '';
  const yaml = serializeManifestObject(object);
  const lines = yaml.split('\n').flatMap((line, index, all) => {
    const top = /^([a-z_]+):/.exec(line)?.[1];
    if (top) section = top;
    const agent = section === 'agents' && /^  [^\s#][^:]*:\s*$/.test(line);
    const first = agent && /^agents:/.test(all[index - 1] ?? '');
    return (top && index > 0) || (agent && !first) ? ['', line] : [line];
  });
  return root ? `${SCHEMA_LINE}\n${lines.join('\n')}` : lines.join('\n');
}

/** The repository as directories: `list(dir)` names its direct files and subdirectories. */
function tree(repo: LegacyRepo) {
  const files = new Set(repo.paths);
  const exists = (path: string) => files.has(path) || repo.paths.some((p) => p.startsWith(`${path}/`));
  const list = (dir: string): Array<{ name: string; dir: boolean }> => {
    const prefix = `${dir}/`;
    const entries = new Map<string, boolean>();
    for (const path of repo.paths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1 || entries.get(rest) === true);
    }
    return [...entries].map(([name, isDir]) => ({ name, dir: isDir })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const read = (path: string): string => repo.read(path) ?? '';
  return { exists, list, read };
}

/** v1 `[[agents]]` (and the agents its OpenCode folder defines) in the v2 shape the conversion reads. */
function v1AsV2(raw: Table, repo: ReturnType<typeof tree>): Table {
  const dir = safeRepoPath(table(raw.opencode)?.config_dir) ?? LEGACY_OPENCODE_CONFIG_DIR;
  const agents: Record<string, Table> = {};
  for (const entry of repo.list(`${dir}/agents`)) if (!entry.dir && entry.name.endsWith('.md')) agents[entry.name.slice(0, -3)] = {};
  for (const entry of list(raw.agents)) {
    const { name, env, ...grants } = (table(entry) ?? {}) as Table;
    if (typeof name === 'string') agents[name] = { ...grants, ...(env === undefined ? {} : { secrets: env }) };
  }
  // A grant v1 omitted meant `all`.
  for (const block of Object.values(agents)) {
    if (block.kortix_permissions === undefined && block.kortix_cli === undefined) block.kortix_permissions = 'all';
    for (const key of ['connectors', 'secrets', 'skills']) block[key] ??= 'all';
  }
  const jsonc = ['opencode.jsonc', 'opencode.json'].map((name) => `${dir}/${name}`).find(repo.exists);
  const jsoncText = jsonc ? repo.read(jsonc) : null;
  let configured: unknown;
  try {
    configured = jsoncText === null ? undefined : table(parseJsonc(jsoncText))?.default_agent;
  } catch {
    configured = undefined;
  }
  const defaultAgent = typeof configured === 'string' && agents[configured] ? configured : Object.keys(agents)[0];
  return { ...raw, agents, default_agent: raw.default_agent ?? defaultAgent };
}

/**
 * Convert a legacy manifest (`from` 1 or 2) and the files it points at into
 * the latest shape. `manifestPath` is the file it was read from
 * (`kortix.yaml` or `kortix.toml`); the result is written to `kortix.yaml`
 * beside it, and a `kortix.toml` is deleted.
 */
export function convertLegacyManifest(input: Table, from: 1 | 2, manifestPath: string, repo: LegacyRepo): LegacyConversion {
  const fs = tree(repo);
  const raw = from === 1 ? v1AsV2(input, fs) : input;
  const changes: LegacyChange[] = [];
  const overlay: Record<string, string> = {};
  const dropped: string[] = [];
  const rewrite = (path: string, content: string, note: string) => {
    changes.push({ path, action: 'rewrite', note, content });
    overlay[path] = content;
  };
  const harnesses = table(raw.harnesses) ?? {};
  const explicitDir = safeRepoPath(table(raw.opencode)?.config_dir);
  const dirCandidates = explicitDir ? [explicitDir] : [OPENCODE_CONFIG_DIR, LEGACY_OPENCODE_CONFIG_DIR];
  const opencodeDir = dirCandidates.find(fs.exists) ?? dirCandidates[0]!;
  const legacyDir = explicitDir ?? LEGACY_OPENCODE_CONFIG_DIR;

  // v2 also ran agents that only the OpenCode folder declared, with no skill restriction.
  const agents: Table = { ...(table(raw.agents) ?? {}) };
  const folderAgents = new Map<string, string>();
  for (const sub of ['agents', 'agent']) {
    for (const entry of fs.list(`${opencodeDir}/${sub}`)) {
      const name = entry.name.replace(/\.md$/, '');
      if (entry.dir || !entry.name.endsWith('.md') || agents[name] !== undefined) continue;
      agents[name] = { skills: 'all' };
      folderAgents.set(name, `${opencodeDir}/${sub}/${entry.name}`);
    }
  }
  const names = Object.keys(agents);
  const defaultAgent = typeof raw.default_agent === 'string' ? raw.default_agent : names[0];

  // opencode.json[c]: its `permission` moves onto every agent that sets none.
  let projectPermission: unknown;
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const path = `${opencodeDir}/${name}`;
    if (!fs.exists(path)) continue;
    let config: Table = {};
    const text = fs.read(path);
    try {
      config = table(parseJsonc(text)) ?? {};
    } catch {
      dropped.push(`${path}: not valid JSON, not read`);
    }
    projectPermission = config.permission;
    const lost = Object.keys(config).filter((key) => !['$schema', 'permission', 'default_agent'].includes(key));
    if (lost.length > 0) dropped.push(`${path}: ${lost.join(', ')} (no project-wide harness config any more)`);
    changes.push({ path, action: 'delete', note: 'permission copied onto each agent that sets none' });
  }

  // Skills: every folder with a SKILL.md; Kortix skills are always there.
  const skills: Table = {};
  for (const dir of [SKILLS_DIR, `${legacyDir}/skills`]) {
    for (const entry of fs.list(dir)) {
      const name = entry.name;
      if (!entry.dir || name.startsWith('kortix-') || skills[name] || !fs.exists(`${dir}/${name}/SKILL.md`)) continue;
      if (REGISTRY_NAME_RE.test(name)) skills[name] = `${dir}/${name}`;
      else dropped.push(`${dir}/${name}: "${name}" is not a valid skill name (lowercase words joined by "-")`);
    }
  }

  // Commands: each enabled on its frontmatter's agent, else the default agent.
  const commands: Table = {};
  const commandsOf = new Map<string, string[]>();
  for (const sub of ['commands', 'command']) {
    for (const entry of fs.list(`${opencodeDir}/${sub}`)) {
      if (entry.dir || !entry.name.endsWith('.md')) continue;
      const path = `${opencodeDir}/${sub}/${entry.name}`;
      const { frontmatter, body, loose } = splitFrontmatter(fs.read(path));
      if (loose) dropped.push(`${path}: the frontmatter is not valid YAML; its single-line keys were read, any nested key was not`);
      const name = registryName(entry.name.replace(/\.md$/, ''), new Set(Object.keys(commands)));
      const target = fs.exists(`commands/${name}.md`) ? path : `commands/${name}.md`;
      commands[name] = ordered({ description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined, prompt_file: target }, ['description', 'prompt_file']);
      const agent = typeof frontmatter.agent === 'string' && agents[frontmatter.agent] ? frontmatter.agent : defaultAgent;
      if (agent) commandsOf.set(agent, [...(commandsOf.get(agent) ?? []), name]);
      const lost = Object.keys(frontmatter).filter((key) => !['description', 'agent'].includes(key));
      if (lost.length > 0) dropped.push(`${path}: ${lost.join(', ')} (a command is description + prompt)`);
      rewrite(target, body, `frontmatter → commands.${name}`);
      if (target !== path) changes.push({ path, action: 'delete', note: `moved to ${target}` });
    }
  }

  // Extensions: pi packages. OpenCode plugins did nothing once every session ran pi: reported, not carried over.
  const extensions: Table = {};
  const extensionsOf = new Map<string, string[]>(names.map((name) => [name, []]));
  const taken = new Set<string>();
  for (const entry of fs.list(`${opencodeDir}/plugins`)) {
    if (!entry.dir && /\.[cm]?[jt]s$/.test(entry.name)) dropped.push(`${opencodeDir}/plugins/${entry.name}: an OpenCode plugin; every session runs pi, which does not load it`);
  }
  const piPackages = list(table(harnesses.pi)?.packages);
  const piName = new Map<string, string>();
  const addPi = (entry: unknown) => {
    const key = piPackageKey(entry);
    if (!key) return null;
    if (!piName.has(key)) {
      const name = registryName(key, taken);
      piName.set(key, name);
      extensions[name] = { pi: piSource(entry) };
    }
    return piName.get(key)!;
  };
  for (const name of names) {
    const own = table(table(agents[name])?.harnesses) ?? {};
    const enabled = extensionsOf.get(name)!;
    const excludedPi = list(table(own.pi)?.exclude).map(String);
    for (const entry of [...piPackages.filter((pkg) => !excludedPi.includes(piPackageKey(pkg) ?? '')), ...list(table(own.pi)?.packages)]) {
      const extension = addPi(entry);
      if (extension && !enabled.includes(extension)) enabled.push(extension);
    }
  }
  if (fs.exists('harnesses/pi') || fs.exists('.kortix/pi')) dropped.push('harnesses/pi (or .kortix/pi): no pi config folder is read; register a pi extension under `extensions` with `pi: <repo path>`');

  // Tools: project modules stay; the Kortix tools v2 left out become a per-agent exclude.
  const toolMap = table(raw.tools);
  const tools = toolMap ? Object.fromEntries(Object.entries(toolMap).filter(([, value]) => kortixToolRef(value) === null)) : {};
  const removedTools = toolMap ? KORTIX_TOOL_NAMES.filter((name) => !selectedKortixTools(toolMap).includes(name)) : [];

  // Agents.
  const codemodeTop = table(harnesses.pi)?.codemode;
  const nextAgents: Table = {};
  for (const name of names) {
    const block = table(agents[name]) ?? {};
    const next: Table = {};
    const folderPath = folderAgents.get(name);
    const explicitFile = block.file !== undefined ? safeAgentFile(block.file) : undefined;
    const candidates = explicitFile !== undefined ? (explicitFile ? [explicitFile] : []) : [`${AGENTS_DIR}/${name}.md`, `${legacyDir}/agents/${name}.md`];
    const mdPath = folderPath ?? candidates.find(fs.exists);
    let frontmatter: Table = {};
    if (mdPath) {
      const split = splitFrontmatter(fs.read(mdPath));
      frontmatter = split.frontmatter;
      if (split.loose) dropped.push(`${mdPath}: the frontmatter is not valid YAML; its single-line keys were read, any nested key was not`);
      const moved = Object.keys(frontmatter).filter((key) => key !== 'name');
      const target = folderPath && !fs.exists(`${AGENTS_DIR}/${name}.md`) ? `${AGENTS_DIR}/${name}.md` : mdPath;
      next.prompt_file = target;
      rewrite(target, split.body, `${folderPath ? 'declared from the OpenCode folder; ' : ''}frontmatter → agents.${name}${moved.length ? ` (${moved.join(', ')})` : ''}`);
      if (target !== mdPath) changes.push({ path: mdPath, action: 'delete', note: `moved to ${target}` });
    }
    for (const key of BEHAVIOR_KEYS) if (frontmatter[key] !== undefined) next[key] = frontmatter[key];
    const permission = frontmatter.permission ?? projectPermission;
    const permissionTable = table(permission);
    next.permission = permissionTable ? Object.fromEntries(Object.entries(permissionTable).filter(([key]) => key !== 'skill' && key !== 'task')) : permission;
    if (permissionTable && Object.keys(next.permission as Table).length === 0) next.permission = undefined;
    if (next.permission === 'allow') next.permission = undefined;
    next.subagents = subagentsGrant(permissionTable?.task);
    for (const key of KEEP_KEYS) if (block[key] !== undefined) next[key] = block[key];
    if (frontmatter.disable === true || block.disable === true) next.enabled = false;
    if (block.kortix_cli !== undefined && next.kortix_permissions === undefined) next.kortix_permissions = block.kortix_cli;
    if (block.connectors_personal !== undefined && next.connectors_required === undefined) next.connectors_required = block.connectors_personal;
    // v2 cloned the repository when the key was omitted; the latest shape does not: pin the v2 value.
    const repository = projectRepository(block);
    next.workspace = repository === undefined ? undefined : { project_repository: repository };
    const skillGrant = block.skills;
    next.skills = Array.isArray(skillGrant) ? skillGrant.filter((skill) => typeof skill === 'string' && (skill.startsWith('kortix-') || skills[skill] !== undefined)) : skillGrant;
    if (Array.isArray(skillGrant) && (next.skills as unknown[]).length !== skillGrant.length) {
      dropped.push(`agents.${name}.skills: ${skillGrant.filter((skill) => !(next.skills as unknown[]).includes(skill)).join(', ')} (no such skill folder)`);
    }
    next.tools = toolsGrant(block.tools ?? frontmatter.tools, removedTools) ?? 'all';
    if (commandsOf.get(name)?.length) next.commands = commandsOf.get(name);
    if (extensionsOf.get(name)?.length) next.extensions = extensionsOf.get(name);
    const codemode = table(table(block.harnesses)?.pi)?.codemode ?? codemodeTop;
    if (codemode !== undefined) next.codemode = codemode;
    // A key the conversion does not read is kept as written: a typo is reported at its line, and a deprecated shape converts below.
    for (const [key, value] of Object.entries(block)) {
      if (CONVERTED_BLOCK_KEYS.has(key) || next[key] !== undefined || value === undefined) continue;
      if (key === 'prompt' && next.prompt_file !== undefined) {
        dropped.push(`agents.${name}.prompt: ${next.prompt_file as string} is this agent's prompt`);
        continue;
      }
      next[key] = value;
    }
    const lostKeys = Object.keys(frontmatter).filter((key) => ![...BEHAVIOR_KEYS, 'permission', 'disable', 'tools', 'name'].includes(key));
    if (lostKeys.length > 0) dropped.push(`${mdPath}: ${lostKeys.join(', ')} (not an agent key)`);
    nextAgents[name] = ordered(next, AGENT_ORDER);
  }

  // `runtime` is a harness name that selects nothing; a table there (the one-day `[runtime]` control plane) never ran.
  const runtime = typeof raw.runtime === 'string' ? raw.runtime : undefined;
  if (raw.runtime !== undefined && runtime === undefined) dropped.push('runtime: not a harness name; every session runs pi');
  const known = [...TOP_LEVEL_ORDER, 'kortix_version', 'opencode', 'pi', 'harnesses'];
  for (const key of Object.keys(raw)) if (!known.includes(key)) dropped.push(`${key} (not a kortix.yaml key)`);
  // The v1 `[[apps]]` list was retired before v2; today's `apps` is a map of App settings.
  if (Array.isArray(raw.apps)) dropped.push('apps: the `[[apps]]` list was retired; deploy Apps with `kortix apps`');
  const next = ordered(
    {
      ...Object.fromEntries(TOP_LEVEL_ORDER.map((key) => [key, raw[key]])),
      runtime,
      apps: Array.isArray(raw.apps) ? undefined : raw.apps,
      skills: Object.keys(skills).length ? skills : undefined,
      tools: Object.keys(tools).length ? tools : undefined,
      commands: Object.keys(commands).length ? commands : undefined,
      extensions: Object.keys(extensions).length ? extensions : undefined,
      agents: nextAgents,
    },
    TOP_LEVEL_ORDER,
  );
  const target = manifestPath.replace(/\.(toml|ya?ml)$/i, '.yaml');
  // A deprecated shape the file kept (an agent's `env`, `runtime`) is rewritten like any other file's.
  const content = fixManifestText(renderManifest(next)).text;
  changes.unshift({ path: target, action: 'rewrite', note: `the kortix_version ${from} manifest in the current shape`, content });
  if (target !== manifestPath) changes.push({ path: manifestPath, action: 'delete', note: `replaced by ${target}` });
  return { from, raw: parseManifestText(content), changes, overlay, dropped };
}

/** Thrown by the reader `convertLegacyManifestAsync` gives the conversion when a file is not loaded yet. */
class LegacyReadPending extends Error {
  constructor(readonly path: string) {
    super(`legacy read pending: ${path}`);
  }
}

/** `convertLegacyManifest` over an async `read`: each file is read once, then the conversion runs again. */
export async function convertLegacyManifestAsync(
  input: Table,
  from: 1 | 2,
  manifestPath: string,
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<LegacyConversion> {
  const loaded = new Map<string, string | null>();
  for (let round = 0; round < 1000; round += 1) {
    try {
      return convertLegacyManifest(input, from, manifestPath, {
        paths,
        read(path) {
          if (!loaded.has(path)) throw new LegacyReadPending(path);
          return loaded.get(path)!;
        },
      });
    } catch (error) {
      if (!(error instanceof LegacyReadPending)) throw error;
      loaded.set(error.path, await read(error.path));
    }
  }
  throw new Error('legacy conversion read too many files');
}

/** The warning a legacy manifest carries: it works, and `--fix` converts it. */
export function legacyFormatMessage(from: 1 | 2): string {
  const what = from === 1 ? '`kortix.toml` (`kortix_version = 1`)' : '`kortix_version: 2`';
  return `Deprecated: this project's manifest is ${what}, an older format. It still works: Kortix reads it as the current kortix.yaml. \`kortix validate --fix\` converts the files for good.`;
}
