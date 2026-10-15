/**
 * kortix.yaml v2 → v3. Pure apart from reading the checkout: `planMigration`
 * returns the new manifest and every file change; the `migrate` command
 * prints or applies it.
 *
 * What moves where:
 *   - each agent's `.md` frontmatter → its kortix.yaml block; the body stays in
 *     the same file as its `prompt_file`;
 *   - `<opencode dir>/opencode.json[c]` `permission` → every agent that sets none;
 *   - `skills/*` (and the legacy `<opencode dir>/skills/*`) → the `skills` registry;
 *   - `<opencode dir>/command(s)/*.md` → the `commands` registry, enabled on the
 *     agent its frontmatter names, else `default_agent`;
 *   - OpenCode plugins and `harnesses.pi.packages` → `extensions`, enabled on
 *     every agent that loaded them;
 *   - `permission.task` → `subagents`; `harnesses.pi.codemode` → `codemode`;
 *   - top-level `tools` keeps only project modules; the Kortix tools v2 left
 *     out become an `exclude` on each agent.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  KORTIX_TOOL_NAMES,
  REGISTRY_NAME_RE,
  kortixToolRef,
  serializeManifestObject,
  validateManifest,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import { agentFileCandidates, opencodeConfigDirCandidates, skillDirs } from '@kortix/manifest-schema/layout';

type Table = Record<string, unknown>;

export interface MigrationChange {
  path: string;
  action: 'rewrite' | 'delete';
  /** One line: what changes and why. */
  note: string;
  /** New content for `rewrite`. */
  content?: string;
}

export interface MigrationPlan {
  manifest: string;
  /** The v3 manifest as an object, before it is rendered (`renderManifest`). */
  next: Table;
  changes: MigrationChange[];
  /** Things v3 has no place for, dropped with the reason. */
  dropped: string[];
  issues: ManifestIssue[];
  valid: boolean;
}

const BEHAVIOR_KEYS = ['description', 'mode', 'model', 'variant', 'temperature', 'top_p', 'steps', 'options', 'color', 'hidden'];
const KEEP_KEYS = ['enabled', 'connectors', 'connectors_required', 'secrets', 'apps', 'kortix_permissions', 'workspace', 'sandbox', 'network_egress'];
const TOP_LEVEL_ORDER = ['kortix_version', 'project', 'default_agent', 'runtime', 'imports', 'env', 'sandbox', 'skills', 'tools', 'commands', 'extensions', 'connectors', 'apps', 'policy', 'policies', 'agents', 'triggers'];
const AGENT_ORDER = [...BEHAVIOR_KEYS, 'prompt_file', 'permission', 'enabled', 'tools', 'skills', 'subagents', 'commands', 'extensions', 'codemode', 'connectors', 'connectors_required', 'secrets', 'apps', 'kortix_permissions', 'workspace', 'sandbox', 'network_egress'];

const table = (value: unknown): Table | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : null;

function ordered(object: Table, order: string[]): Table {
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined).sort(([a], [b]) => rank(a) - rank(b)));
}

/** `---` frontmatter and the body after it. */
export function splitFrontmatter(text: string): { frontmatter: Table; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  return { frontmatter: table(parseYaml(match[1]!)) ?? {}, body: match[2]!.replace(/^\s*\n/, '') };
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

/** `npm:@scope/name@1.2.3` → `@scope/name`; `./path` → `./path`. The identity v2 `exclude` uses. */
function piPackageKey(entry: unknown): string | null {
  const source = typeof entry === 'string' ? entry : table(entry)?.source;
  if (typeof source !== 'string') return null;
  return /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@.*)?$/.exec(source)?.[1] ?? source;
}

/** A v2 pi source in v3 form: a `./` repo path loses its `./`. */
function piSourceV3(entry: unknown): unknown {
  const fix = (source: unknown) => (typeof source === 'string' && source.startsWith('./') ? source.slice(2) : source);
  const filter = table(entry);
  return filter ? { ...filter, source: fix(filter.source) } : fix(entry);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** v2 `tools` (an agent's grant or an OpenCode `{ name: bool }` map) in v3 form, minus the Kortix tools v2 removed. */
function toolsV3(value: unknown, removed: string[]): unknown {
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

/** `permission.task` as a v3 `subagents` grant: undefined (none) when it denies every agent. */
function subagentsV3(task: unknown): unknown {
  if (task === undefined || task === 'allow' || task === 'ask') return 'all';
  if (task === 'deny') return undefined;
  const rules = table(task);
  if (!rules) return 'all';
  const named = Object.entries(rules).filter(([name, action]) => name !== '*' && action !== 'deny').map(([name]) => name);
  if (rules['*'] !== undefined && rules['*'] !== 'deny') return 'all';
  return named.length > 0 ? named : undefined;
}

const SCHEMA_LINE = '# yaml-language-server: $schema=https://kortix.com/schema/kortix.v3.schema.json';

/** A manifest object as v3 YAML. The root file carries the schema line; an imported file does not. */
export function renderManifest(object: Table, root = true): string {
  const yaml = spaced(serializeManifestObject(object, 'yaml'));
  return root ? `${SCHEMA_LINE}\n${yaml}` : yaml;
}

/** A blank line between top-level sections and between agents. */
function spaced(yaml: string): string {
  let section = '';
  const lines = yaml.split('\n').flatMap((line, index) => {
    const top = /^([a-z_]+):/.exec(line)?.[1];
    if (top) section = top;
    const agent = section === 'agents' && /^  [^\s#][^:]*:\s*$/.test(line) && !/^agents:/.test(line);
    const first = section === 'agents' && agent && /^agents:/.test(yaml.split('\n')[index - 1] ?? '');
    return (top && index > 0) || (agent && !first) ? ['', line] : [line];
  });
  return lines.join('\n');
}

export function planMigration(root: string, manifestPath: string, raw: Table): MigrationPlan {
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const exists = (path: string) => existsSync(resolve(root, path));
  const files = (dir: string) =>
    exists(dir) ? readdirSync(resolve(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const changes: MigrationChange[] = [];
  const dropped: string[] = [];
  const agents = table(raw.agents) ?? {};
  const names = Object.keys(agents);
  const defaultAgent = typeof raw.default_agent === 'string' ? raw.default_agent : names[0];
  const harnesses = table(raw.harnesses) ?? {};
  const opencodeDir = opencodeConfigDirCandidates(raw).find((dir) => exists(`${dir}/opencode.jsonc`) || exists(`${dir}/opencode.json`) || exists(dir)) ?? opencodeConfigDirCandidates(raw)[0]!;

  // opencode.json[c]: its `permission` moves onto every agent that sets none.
  let projectPermission: unknown;
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const path = `${opencodeDir}/${name}`;
    if (!exists(path)) continue;
    const config = table(parseJsonc(read(path))) ?? {};
    projectPermission = config.permission;
    const lost = Object.keys(config).filter((key) => !['$schema', 'permission', 'default_agent'].includes(key));
    if (lost.length > 0) dropped.push(`${path}: ${lost.join(', ')} (v3 has no project-wide harness config)`);
    changes.push({ path, action: 'delete', note: `permission copied onto each agent that sets none` });
  }

  // Skills: every folder with a SKILL.md, Kortix skills excepted (always registered).
  const skills: Table = {};
  for (const dir of skillDirs(raw)) {
    for (const entry of files(dir)) {
      const name = entry.name;
      if (!entry.isDirectory() || name.startsWith('kortix-') || skills[name] || !exists(`${dir}/${name}/SKILL.md`)) continue;
      if (REGISTRY_NAME_RE.test(name)) skills[name] = `${dir}/${name}`;
      else dropped.push(`${dir}/${name}: "${name}" is not a valid skill name (lowercase words joined by "-")`);
    }
  }

  // Commands: each enabled on its frontmatter's agent, else the default agent.
  const commands: Table = {};
  const commandsOf = new Map<string, string[]>();
  for (const sub of ['commands', 'command']) {
    for (const entry of files(`${opencodeDir}/${sub}`)) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = `${opencodeDir}/${sub}/${entry.name}`;
      const { frontmatter, body } = splitFrontmatter(read(path));
      const name = registryName(entry.name.replace(/\.md$/, ''), new Set(Object.keys(commands)));
      commands[name] = ordered({ description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined, prompt_file: path }, ['description', 'prompt_file']);
      const agent = typeof frontmatter.agent === 'string' && agents[frontmatter.agent] ? frontmatter.agent : defaultAgent;
      if (agent) commandsOf.set(agent, [...(commandsOf.get(agent) ?? []), name]);
      const lost = Object.keys(frontmatter).filter((key) => !['description', 'agent'].includes(key));
      if (lost.length > 0) dropped.push(`${path}: ${lost.join(', ')} (a v3 command is description + prompt)`);
      changes.push({ path, action: 'rewrite', note: `frontmatter → commands.${name}`, content: body });
    }
  }

  // Extensions: OpenCode plugins as v2 selected them, then pi packages.
  const extensions: Table = {};
  const extensionsOf = new Map<string, string[]>(names.map((name) => [name, []]));
  const taken = new Set<string>();
  const plugins = files(`${opencodeDir}/plugins`).filter((entry) => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)).map((entry) => entry.name);
  const pluginName = new Map(plugins.map((file) => [file, registryName(file, taken)]));
  for (const [file, name] of pluginName) extensions[name] = { opencode: `${opencodeDir}/plugins/${file}` };
  const globalPlugins = list(table(harnesses.opencode)?.plugins).map(String);
  const selection = table(harnesses.opencode)?.plugins !== undefined || names.some((name) => table(table(table(agents[name])?.harnesses)?.opencode)?.plugins !== undefined || table(table(table(agents[name])?.harnesses)?.opencode)?.exclude !== undefined);
  const piPackages = list(table(harnesses.pi)?.packages);
  const piName = new Map<string, string>();
  const addPi = (entry: unknown) => {
    const key = piPackageKey(entry);
    if (!key) return null;
    if (!piName.has(key)) {
      const name = registryName(key, taken);
      piName.set(key, name);
      extensions[name] = { pi: piSourceV3(entry) };
    }
    return piName.get(key)!;
  };
  for (const name of names) {
    const own = table(table(agents[name])?.harnesses) ?? {};
    const excludedPlugins = list(table(own.opencode)?.exclude).map(String);
    const loaded = selection ? [...globalPlugins.filter((file) => !excludedPlugins.includes(file)), ...list(table(own.opencode)?.plugins).map(String)] : plugins;
    const enabled = extensionsOf.get(name)!;
    for (const file of loaded) {
      const extension = pluginName.get(file);
      if (extension && !enabled.includes(extension)) enabled.push(extension);
      else if (!extension) dropped.push(`agents.${name}: plugin ${file} is not in ${opencodeDir}/plugins`);
    }
    const excludedPi = list(table(own.pi)?.exclude).map(String);
    for (const entry of [...piPackages.filter((pkg) => !excludedPi.includes(piPackageKey(pkg) ?? '')), ...list(table(own.pi)?.packages)]) {
      const extension = addPi(entry);
      if (extension && !enabled.includes(extension)) enabled.push(extension);
    }
  }
  if (exists('harnesses/pi') || exists('.kortix/pi')) dropped.push('harnesses/pi (or .kortix/pi): v3 reads no pi config folder; register a pi extension under `extensions` with `pi: <repo path>`');

  // Tools: project modules stay; the Kortix tools v2 left out become a per-agent exclude.
  const toolMap = table(raw.tools);
  const tools = toolMap ? Object.fromEntries(Object.entries(toolMap).filter(([, value]) => kortixToolRef(value) === null)) : {};
  const removedTools = toolMap ? KORTIX_TOOL_NAMES.filter((name) => !Object.hasOwn(toolMap, name)) : [];

  // Agents.
  const codemodeTop = table(harnesses.pi)?.codemode;
  const nextAgents: Table = {};
  for (const name of names) {
    const block = table(agents[name]) ?? {};
    const next: Table = {};
    const mdPath = agentFileCandidates(raw, name).find(exists);
    let frontmatter: Table = {};
    if (mdPath) {
      const split = splitFrontmatter(read(mdPath));
      frontmatter = split.frontmatter;
      next.prompt_file = mdPath;
      const moved = Object.keys(frontmatter).filter((key) => key !== 'name');
      changes.push({ path: mdPath, action: 'rewrite', note: `frontmatter → agents.${name}${moved.length ? ` (${moved.join(', ')})` : ''}`, content: split.body });
    }
    for (const key of BEHAVIOR_KEYS) if (frontmatter[key] !== undefined) next[key] = frontmatter[key];
    const permission = frontmatter.permission ?? projectPermission;
    const permissionTable = table(permission);
    next.permission = permissionTable ? Object.fromEntries(Object.entries(permissionTable).filter(([key]) => key !== 'skill' && key !== 'task')) : permission;
    if (permissionTable && Object.keys(next.permission as Table).length === 0) next.permission = undefined;
    if (next.permission === 'allow') next.permission = undefined;
    next.subagents = subagentsV3(permissionTable?.task);
    for (const key of KEEP_KEYS) if (block[key] !== undefined) next[key] = block[key];
    if (frontmatter.disable === true || block.disable === true) next.enabled = false;
    if (block.kortix_cli !== undefined && next.kortix_permissions === undefined) next.kortix_permissions = block.kortix_cli;
    if (block.connectors_personal !== undefined && next.connectors_required === undefined) next.connectors_required = block.connectors_personal;
    if (typeof block.repository_access === 'boolean' && next.workspace === undefined) next.workspace = { project_repository: block.repository_access };
    const skillGrant = block.skills;
    next.skills = Array.isArray(skillGrant) ? skillGrant.filter((skill) => typeof skill === 'string' && (skill.startsWith('kortix-') || skills[skill] !== undefined)) : skillGrant;
    if (Array.isArray(skillGrant) && (next.skills as unknown[]).length !== skillGrant.length) {
      dropped.push(`agents.${name}.skills: ${skillGrant.filter((skill) => !(next.skills as unknown[]).includes(skill)).join(', ')} (no such skill folder)`);
    }
    next.tools = toolsV3(block.tools ?? frontmatter.tools, removedTools);
    if (commandsOf.get(name)?.length) next.commands = commandsOf.get(name);
    if (extensionsOf.get(name)?.length) next.extensions = extensionsOf.get(name);
    const codemode = table(table(block.harnesses)?.pi)?.codemode ?? codemodeTop;
    if (codemode !== undefined) next.codemode = codemode;
    const lostKeys = Object.keys(frontmatter).filter((key) => ![...BEHAVIOR_KEYS, 'permission', 'disable', 'tools', 'name'].includes(key));
    if (lostKeys.length > 0) dropped.push(`${mdPath}: ${lostKeys.join(', ')} (not a v3 agent key)`);
    nextAgents[name] = ordered(next, AGENT_ORDER);
  }

  const known = [...TOP_LEVEL_ORDER, 'opencode', 'pi', 'harnesses'];
  for (const key of Object.keys(raw)) if (!known.includes(key)) dropped.push(`${key} (not a v3 key)`);
  const next = ordered(
    {
      ...Object.fromEntries(TOP_LEVEL_ORDER.map((key) => [key, raw[key]])),
      kortix_version: 3,
      skills: Object.keys(skills).length ? skills : undefined,
      tools: Object.keys(tools).length ? tools : undefined,
      commands: Object.keys(commands).length ? commands : undefined,
      extensions: Object.keys(extensions).length ? extensions : undefined,
      agents: nextAgents,
    },
    TOP_LEVEL_ORDER,
  );
  const manifest = renderManifest(next);
  changes.unshift({ path: manifestPath, action: 'rewrite', note: 'kortix_version 2 → 3: agents inline, registries, per-agent grants', content: manifest });
  const issues = validateManifest(manifest, 'yaml').issues;
  return { manifest, next, changes, dropped, issues, valid: !issues.some((issue) => issue.severity === 'error') };
}

