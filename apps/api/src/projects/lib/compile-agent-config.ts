/**
 * The runtime compiler: turns kortix.yaml into the compiled agent set a
 * session's harness reads (`KORTIX_COMPILED_AGENT_CONFIG`). The project
 * registers skills, tools, commands and extensions; each agent is one block of
 * behavior that enables registered things by name. Every grant compiles to
 * something a harness enforces: `skills` and `subagents` own
 * `permission.skill` / `permission.task`, `commands` becomes each command's
 * `agents`, `extensions` the agent's list. Only declared agents run.
 *
 * `compileAgentConfig` is pure — no I/O, no DB. The `resolve…ForSession`
 * functions are the I/O half: they read kortix.yaml and the prompt files from
 * git and compile what a running project applies (`usableManifest`): a broken
 * part of the file is turned off or dropped, never fatal, and the errors ride
 * along as `manifest_issues` so the session's agent can fix the file.
 */
import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { CompiledAgent, CompiledAgentSet } from '@kortix/api-contract/runtime-relay';
import { orderPermissionRules } from '@kortix/api-contract/permission-rules';
import {
  safeAgentFile,
  manifestCandidatePaths,
  HARNESS_TOOL_NAMES,
  safeToolFile,
  TOOL_NAME_RE,
  usableManifest,
  validateManifest,
  type AgentBlockV3,
  type AgentToolsV3,
  type CommandV3,
  type ExtensionV3,
  KORTIX_SKILL_NAMES,
  type ManifestV3,
  OPENCODE_BUILTIN_AGENTS_V3,
  excludedNamesV3,
  grantedNamesV3,
  type ManifestIssue,
  parseManifestText,
  type PermissionActionV2,
  type PermissionConfigObjectV2,
  type PermissionConfigV2,
  type PermissionRuleV2,
} from '@kortix/manifest-schema';
import {
  isRepoFileNotFoundError,
  readManifestFromRepo,
  readRepoFile,
  type GitBackedProject,
  type MirrorRefresh,
} from '../git';
import { manifestIssueSummary } from '../manifest-io';
import { reportedManifestIssues } from './manifest-health';

/**
 * One compiled agent (`CompiledAgent` in `@kortix/api-contract/runtime-relay`,
 * the shape both harnesses read), with the manifest's permission type.
 */
type CompiledAgentEntry = CompiledAgent & { permission?: PermissionConfigV2 };


/**
 * The compiled agent set `compileAgentConfig` produces (`CompiledAgentSet`).
 * `model` is the default agent's compiled model, so a session that picked no
 * agent starts on the model its default agent resolves to; omitted when that
 * agent declares none. `default_agent` is omitted when that agent is disabled
 * or a subagent, which cannot run as the primary. `manifest_issues`: the
 * file's errors, at most `MANIFEST_ISSUE_LIMIT`; omitted when there are none.
 * kortixd lists them in the session's config notice.
 */
type CompiledAgents = CompiledAgentSet & { agent: Record<string, CompiledAgentEntry> };

/** A manifest the compile could not apply as written — names the agent when one is the cause. */
export class CompileAgentConfigError extends Error {
  constructor(
    message: string,
    public readonly agent?: string,
  ) {
    super(message);
    this.name = 'CompileAgentConfigError';
  }
}

/** Behavior keys an agent block copies onto its compiled agent. */
const BEHAVIOR_KEYS = ['description', 'mode', 'model', 'variant', 'temperature', 'top_p', 'options', 'color', 'steps', 'hidden'] as const;

/** The agent-config editor's wire schema for the `behavior` half of a PUT
 *  body: the behavior keys of an `agents.<name>` block, typed for their real
 *  shapes, plus `prompt` (the prompt text). */
export const OpencodeAgentConfigSchema = z
  .object({
    description: z.string().max(2000).optional(),
    mode: z.enum(['primary', 'subagent', 'all']).optional(),
    model: z.string().max(200).optional(),
    variant: z.string().max(200).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    /** The `.md` BODY (the system prompt text), not a file path. */
    prompt: z.string().max(50_000).optional(),
    hidden: z.boolean().optional(),
    options: z.record(z.string(), z.any()).optional(),
    color: z.string().max(64).optional(),
    steps: z.number().optional(),
    permission: z.any().optional(),
  })
  .strict();


/**
 * Compile a manifest's declared agents. `manifest` is what the project applies
 * (`usableManifest`); `files` maps each `prompt_file` path to its text. An
 * enabled agent whose prompt file is not in `files` compiles off, and a
 * command whose prompt file is missing is left out: each adds an error to
 * `issues`, which become `manifest_issues`.
 */
export function compileAgentConfig(
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  issues: ManifestIssue[] = [],
): CompiledAgents {
  return compileManifest(manifest, files, issues);
}

/**
 * Compile one selected agent for a restricted session: that agent, the
 * subagents it may start (transitively), and only the commands and extensions
 * those agents enable. A selected agent that is missing, off, or without its
 * prompt file throws `CompileAgentConfigError`.
 */
export function compileSelectedAgentConfig(
  manifest: Record<string, unknown>,
  agentName: string,
  files: Record<string, string> = {},
  issues: ManifestIssue[] = [],
): CompiledAgents {
  return compileManifest(manifest, files, issues, agentName);
}

/**
 * Top-level `tools` as `project_tools`: the valid name → module entries;
 * `validateManifest` reports the rest. A harness tool's name never compiles:
 * two tools with one name break the model request. Every Kortix tool loads.
 */
function projectTools(tools: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapOf<unknown>(tools)).flatMap(([name, file]) => {
      const path = safeToolFile(file);
      const reserved = (HARNESS_TOOL_NAMES as readonly string[]).includes(name) || name.startsWith('pty_');
      return TOOL_NAME_RE.test(name) && !reserved && path ? [[name, path] as const] : [];
    }),
  );
}

/** `agents.<name>.tools` as the map a harness reads (`CompiledAgent.tools`): tool name → visible, `*` for every tool not named. Undefined: every tool. */
function agentToolsMap(value: AgentToolsV3 | undefined): Record<string, boolean> | undefined {
  if (value === undefined || value === 'all') return undefined;
  if (value === 'none') return { '*': false };
  if (Array.isArray(value)) return value.includes('*') ? undefined : Object.fromEntries([['*', false], ...value.map((name) => [name, true])]);
  return Object.fromEntries(value.exclude.map((name) => [name, false]));
}

/** Every action of a rule is `deny`: the tool is off, not just filtered by pattern. */
function isBlanketDeny(rule: unknown): boolean {
  if (rule === 'deny') return true;
  if (!rule || typeof rule !== 'object') return false;
  const actions = Object.values(rule as Record<string, unknown>);
  return actions.length > 0 && actions.every((action) => action === 'deny');
}

/**
 * The starter's custom tools are not covered by the built-in permission keys:
 * `pty_*` runs a shell and `memory` writes files, yet OpenCode matches them by
 * their own name, so `bash: deny` / `edit: deny` left both callable (RUN-10).
 * A blanket deny of `bash` or `edit` carries over to the tools that do the
 * same thing. An explicit rule on the tool itself wins.
 */
const SHELL_TOOLS = ['pty_spawn', 'pty_write', 'pty_read', 'pty_kill', 'pty_list'];
const FILE_WRITE_TOOLS = ['memory'];

function denyToolsBehindDeniedPermission(permission: PermissionConfigV2 | undefined): PermissionConfigV2 | undefined {
  if (!permission || typeof permission !== 'object') return permission;
  const out: PermissionConfigObjectV2 = { ...permission };
  const deny = (tools: string[]) => {
    for (const tool of tools) if (out[tool] === undefined) out[tool] = 'deny';
  };
  if (isBlanketDeny(permission.bash)) deny(SHELL_TOOLS);
  if (isBlanketDeny(permission.edit)) deny(FILE_WRITE_TOOLS);
  return out;
}

/**
 * Keys `PermissionConfigObjectV2` recognizes besides `skill`. Used only to
 * expand a bare whole-agent `permission` action into an explicit object when
 * `skills` governance needs to set just the `skill` key — see
 * `applySkillsGovernance`. Kept local (not re-exported) since it's an
 * implementation detail of that expansion, not a schema fact callers need.
 */
const OTHER_PERMISSION_KEYS: readonly string[] = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'lsp',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'doom_loop',
];

/**
 * Set one capability's rule on a permission config. A bare whole-agent action
 * (`permission: allow`) applies to every capability, so it expands into an
 * explicit object first: setting one key must not drop the author's intent for
 * everything else.
 */
function withPermissionRule(
  base: PermissionConfigV2 | undefined,
  key: string,
  rule: PermissionRuleV2,
): PermissionConfigObjectV2 {
  if (base === undefined) return { [key]: rule };
  if (typeof base === 'string') {
    const expanded: PermissionConfigObjectV2 = {};
    for (const other of OTHER_PERMISSION_KEYS) expanded[other] = base as PermissionActionV2;
    expanded[key] = rule;
    return expanded;
  }
  return { ...base, [key]: rule };
}

function mapOf<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

/** The names a grant set selects from `universe` (`all`, `{ exclude }`), or as listed. Omitted is none. */
function grantedNames(value: unknown, universe: string[]): string[] {
  return grantedNamesV3(value, universe);
}

/**
 * The `permission.skill` rule of a `skills` grant. `{ exclude }` allows `*`
 * and denies each named skill, so a skill added later is on, like `all`.
 */
function skillsRule(value: unknown, universe: string[]): PermissionRuleV2 {
  const excluded = excludedNamesV3(value);
  return excluded ? excludeRule(excluded) : allowlistRule(grantedNames(value, universe));
}

/** `{ exclude }` as a rule: `*` allow, each named one deny. Nothing excluded: `allow`. */
function excludeRule(excluded: string[]): PermissionRuleV2 {
  if (excluded.length === 0) return 'allow';
  return { '*': 'allow', ...Object.fromEntries(excluded.map((name) => [name, 'deny' as const])) };
}

/** An allowlist rule: everything `deny`, then each name `allow`. No names: `deny`. */
function allowlistRule(names: string[]): PermissionRuleV2 {
  if (names.length === 0) return 'deny';
  return { '*': 'deny', ...Object.fromEntries(names.map((name) => [name, 'allow' as const])) };
}

/** The text of a prompt file the caller read, or null (an error added to `issues`) when it is not there. */
function promptText(files: Record<string, string>, path: string, where: string, issues: ManifestIssue[]): string | null {
  if (safeAgentFile(path) && path in files) return files[path]!;
  issues.push({ path: where, message: `prompt file "${path}" is not a readable repository .md file. Create it, or fix the path.`, severity: 'error' });
  return null;
}

/** The declared agents `name` may start as subagents: enabled, mode `subagent` or `all`, not itself. */
function subagentUniverse(blocks: Record<string, AgentBlockV3>, name: string): string[] {
  return Object.entries(blocks)
    .filter(([other, block]) => other !== name && block.enabled !== false && (block.mode ?? 'all') !== 'primary')
    .map(([other]) => other);
}


function compileManifest(
  manifest: Record<string, unknown>,
  files: Record<string, string>,
  issues: ManifestIssue[],
  selected?: string,
): CompiledAgents {
  const m = manifest as unknown as ManifestV3;
  const blocks = mapOf<AgentBlockV3>(m.agents);
  const skills = mapOf<string>(m.skills);
  const commands = mapOf<CommandV3>(m.commands);
  const extensions = mapOf<ExtensionV3>(m.extensions);
  const skillNames = [...KORTIX_SKILL_NAMES, ...Object.keys(skills)];

  let names = Object.keys(blocks);
  if (selected !== undefined) {
    if (!blocks[selected]) throw new CompileAgentConfigError(`Agent "${selected}" is not declared.`, selected);
    if (blocks[selected]!.enabled === false) throw new CompileAgentConfigError(`Agent "${selected}" is disabled.`, selected);
    const reach = new Set([selected]);
    for (const name of reach) {
      for (const sub of grantedNames(blocks[name]!.subagents, subagentUniverse(blocks, name))) reach.add(sub);
    }
    names = names.filter((name) => reach.has(name));
  }

  const agent: Record<string, CompiledAgentEntry> = {};
  for (const name of names) {
    agent[name] = compileAgent(name, blocks[name]!, files, issues, {
      skills: skillNames,
      subagents: subagentUniverse(blocks, name),
      extensions: Object.keys(extensions),
    });
  }
  if (selected !== undefined && agent[selected]?.disable) {
    throw new CompileAgentConfigError(`Agent "${selected}" is off. ${manifestIssueSummary(issues.filter((i) => i.severity === 'error' && !i.unknownKey && i.path.startsWith(`agents.${selected}.`)))}`, selected);
  }
  // Only declared agents run: OpenCode's own build/plan/general/explore are off.
  for (const builtin of OPENCODE_BUILTIN_AGENTS_V3) {
    if (!blocks[builtin]) agent[builtin] = { disable: true };
  }

  const compiledCommands: NonNullable<CompiledAgentSet['commands']> = {};
  for (const [command, entry] of Object.entries(commands)) {
    const runners = names.filter((name) => !agent[name]!.disable && grantedNames(blocks[name]!.commands, Object.keys(commands)).includes(command));
    if (runners.length === 0) continue;
    const template = entry.prompt ?? promptText(files, entry.prompt_file ?? '', `commands.${command}.prompt_file`, issues);
    if (template === null) continue;
    compiledCommands[command] = {
      ...(entry.description ? { description: entry.description } : {}),
      template,
      agents: runners,
    };
  }

  const used = new Set(names.flatMap((name) => agent[name]!.extensions ?? []));
  const compiledExtensions = Object.fromEntries(Object.entries(extensions).filter(([name]) => used.has(name)));
  const tools = projectTools(m.tools);

  const primary = selected ?? (typeof m.default_agent === 'string' ? m.default_agent : undefined);
  const primaryAgent = primary ? agent[primary] : undefined;
  const runnable = primaryAgent && !primaryAgent.disable && primaryAgent.mode !== 'subagent';
  return {
    schema: 3,
    ...(primaryAgent?.model ? { model: primaryAgent.model } : {}),
    ...(runnable && selected === undefined ? { default_agent: primary } : {}),
    agent,
    ...(Object.keys(tools).length > 0 ? { project_tools: tools } : {}),
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
    ...(Object.keys(compiledCommands).length > 0 ? { commands: compiledCommands } : {}),
    ...(Object.keys(compiledExtensions).length > 0 ? { extensions: compiledExtensions } : {}),
    // Errors only: a warning (e.g. the obsolete `kortix_version`) would put a fix request
    // into every session's system prompt. Warnings reach people through the CLI and the banner.
    ...(issues.some((i) => i.severity === 'error')
      ? { manifest_issues: reportedManifestIssues(issues.filter((i) => i.severity === 'error')) }
      : {}),
  };
}

/** One agent block. An agent that is off compiles to `disable` alone: nothing else of it runs. */
function compileAgent(
  name: string,
  block: AgentBlockV3,
  files: Record<string, string>,
  issues: ManifestIssue[],
  universe: { skills: string[]; subagents: string[]; extensions: string[] },
): CompiledAgentEntry {
  if (block.enabled === false) return { disable: true };
  const out: CompiledAgentEntry = {};
  for (const key of BEHAVIOR_KEYS) {
    if (block[key] !== undefined) (out as Record<string, unknown>)[key] = block[key];
  }
  if (block.prompt !== undefined) out.prompt = block.prompt;
  else if (block.prompt_file !== undefined) {
    const prompt = promptText(files, block.prompt_file, `agents.${name}.prompt_file`, issues);
    if (prompt === null) return { disable: true };
    out.prompt = prompt;
  }
  const tools = agentToolsMap(block.tools);
  if (tools) out.tools = tools;

  // Omitted permission is `allow`: a tool never waits for an answer unless the agent says `ask`.
  let permission = withPermissionRule(block.permission ?? 'allow', 'skill', skillsRule(block.skills, universe.skills));
  permission = withPermissionRule(permission, 'task', allowlistRule(grantedNames(block.subagents, universe.subagents)));
  out.permission = orderPermissionRules(denyToolsBehindDeniedPermission(permission));

  const extensions = grantedNames(block.extensions, universe.extensions);
  if (extensions.length > 0) out.extensions = extensions;
  if (block.codemode !== undefined) out.codemode = block.codemode;
  return out;
}

/**
 * A short content hash of a compiled agent config — the thing a session can
 * compare to answer "am I running the latest?".
 *
 * The compiled JSON already exists at every point that matters (boot, push,
 * recompile), so hashing it costs nothing and needs no new storage. Content, not
 * a commit sha: `refreshWarmSessionWorkspace` advances a box's commit while
 * deliberately skipping the restart, so a sandbox can report the newest commit
 * while running config compiled days earlier. Two commits that do not touch any
 * agent also produce the same config, and calling that "stale" would send people
 * reloading for nothing.
 *
 * 16 hex chars — enough that a collision is not a practical concern for an
 * equality check, short enough to read in a CLI line.
 */
export function agentConfigEtag(compiled: string | null | undefined): string | null {
  if (!compiled) return null;
  return createHash('sha256').update(compiled).digest('hex').slice(0, 16);
}

/** The agent a session runs: `default` (or none) means `default_agent`. */
function manifestAgentBlock(manifest: Record<string, unknown>, agentName?: string | null): AgentBlockV3 | undefined {
  const requested = agentName?.trim();
  // `default` is the session layer's "no agent chosen" (sessions.ts), like the runtime's.
  const name = requested && requested !== 'default' ? requested : typeof manifest.default_agent === 'string' ? manifest.default_agent : '';
  return mapOf<AgentBlockV3>(manifest.agents)[name];
}

/**
 * An agent's pi packages, in pi's settings shape: each extension it enables
 * that has a pi implementation, in registry order. No agent name (or
 * `default`) means `default_agent`.
 */
export function manifestPiPackages(raw: unknown, agentName?: string | null): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const manifest = raw as Record<string, unknown>;
  const extensions = mapOf<ExtensionV3>(manifest.extensions);
  const enabled = new Set(grantedNames(manifestAgentBlock(manifest, agentName)?.extensions, Object.keys(extensions)));
  return Object.entries(extensions).flatMap(([name, entry]) => {
    if (!enabled.has(name) || entry.pi === undefined) return [];
    return [typeof entry.pi === 'string' ? piSettingsSource(entry.pi) : { ...entry.pi, source: piSettingsSource(entry.pi.source) }];
  });
}

/** A pi source in pi's settings shape: a repository path gets the `./` pi reads as "repo-local". */
function piSettingsSource(source: string): string {
  return source.startsWith('npm:') ? source : `./${source}`;
}

/** The agent's `codemode`; null when it sets none (the daemon's default, `on`). */
export function manifestPiCodemode(raw: unknown, agentName?: string | null): 'off' | 'on' | 'only' | null {
  if (!raw || typeof raw !== 'object') return null;
  return manifestAgentBlock(raw as Record<string, unknown>, agentName)?.codemode ?? null;
}

/** Every distinct non-empty package list the manifest's agents resolve to: what a merge builds. */
export function manifestPiPackageLists(raw: unknown): unknown[][] {
  if (!raw || typeof raw !== 'object') return [];
  const agents = Object.keys(((raw as Record<string, unknown>).agents as Record<string, unknown> | undefined) ?? {});
  const lists = new Map<string, unknown[]>();
  for (const name of agents.length ? agents : [null]) {
    const list = manifestPiPackages(raw, name);
    if (list.length) lists.set(JSON.stringify(list), list);
  }
  return [...lists.values()];
}

/** What the project at `baseRef` (default branch when absent) applies; null for none or a read failure. */
async function readUsableManifest(project: GitBackedProject, baseRef?: string | null): Promise<Record<string, unknown> | null> {
  const ref = baseRef?.trim() || project.defaultBranch;
  try {
    const found = await readManifestFromRepo(project, manifestCandidatePaths(project.manifestPath), ref);
    if (!found) return null;
    const { parsed, issues } = validateManifest(found.content);
    return usableManifest(parsed, issues);
  } catch {
    return null;
  }
}

export async function resolveManifestPiPackageLists(project: GitBackedProject, baseRef?: string | null): Promise<unknown[][]> {
  return manifestPiPackageLists(await readUsableManifest(project, baseRef));
}

/**
 * Observe the manifest a compile read, without a second git round trip. The
 * session env builder uses it to learn `runtime:` from the same read that
 * compiles the agent config.
 */
interface CompileReadOptions {
  onManifest?: (raw: Record<string, unknown>) => void;
  /**
   * Force the manifest read's mirror refresh with the ref-scoped freshness
   * proof: `readManifestFromRepo` proves THIS ref against the remote with one
   * `git ls-remote` and only fetches the whole mirror when the branch moved.
   * A caller that must answer "latest" proves the ref instead of trusting the
   * 60s TTL. Omitted keeps the plain TTL behavior.
   */
  forceRefresh?: MirrorRefresh;
}

/**
 * Compiled configs by the commit they were compiled from. A commit never
 * changes, so an entry is never stale. Session create, restart and open
 * compiled the same commit once each; the company project's config is
 * ~380 KB from ~40 files (2026-10-30).
 */
// replica-local: a cache of immutable per-commit output; a miss recompiles.
const compiledAtCommit = new Map<string, { raw: Record<string, unknown>; compiled: string | null }>();
const COMPILED_AT_COMMIT_MAX = 32;

function compiledAt(key: string | null): { raw: Record<string, unknown>; compiled: string | null } | undefined {
  const hit = key ? compiledAtCommit.get(key) : undefined;
  if (hit) {
    // Re-insert: the Map's insertion order is the eviction order.
    compiledAtCommit.delete(key!);
    compiledAtCommit.set(key!, hit);
  }
  return hit;
}

function rememberCompiled(key: string | null, entry: { raw: Record<string, unknown>; compiled: string | null }): void {
  if (!key) return;
  compiledAtCommit.set(key, entry);
  while (compiledAtCommit.size > COMPILED_AT_COMMIT_MAX) {
    compiledAtCommit.delete(compiledAtCommit.keys().next().value!);
  }
}

/** The cache key of a compile from the manifest read `found`, or null when its commit is unknown. */
function commitKey(project: GitBackedProject, found: { commit: string | null; path: string }, selection: string): string | null {
  return found.commit ? [project.projectId, found.commit, found.path, selection].join('\0') : null;
}

/** Test seam: start from a cold cache. */
export function __resetCompiledAtCommitForTests(): void {
  compiledAtCommit.clear();
}

/**
 * Every prompt file the manifest names (agents and commands), read at `ref`.
 * A missing file is left out (the compile turns its agent off and names the
 * file in `manifest_issues`); any other read failure throws.
 */
async function readPromptFiles(project: GitBackedProject, raw: Record<string, unknown>, ref: string, overlay: Record<string, string> = {}): Promise<Record<string, string>> {
  const paths = new Set<string>();
  for (const block of [...Object.values(mapOf<{ prompt_file?: unknown }>(raw.agents)), ...Object.values(mapOf<{ prompt_file?: unknown }>(raw.commands))]) {
    if (typeof block?.prompt_file === 'string' && safeAgentFile(block.prompt_file)) paths.add(block.prompt_file);
  }
  const files: Record<string, string> = {};
  await Promise.all([...paths].map(async (path) => {
    // A converted legacy file: the prompt without its frontmatter, or a command moved out of the harness folder.
    if (overlay[path] !== undefined) {
      files[path] = overlay[path];
      return;
    }
    try {
      files[path] = await readRepoFile(project, path, ref);
    } catch (err) {
      if (!isRepoFileNotFoundError(err)) throw err;
    }
  }));
  return files;
}

/**
 * kortix.yaml at `ref`, as the project applies it: `usable` (`usableManifest`)
 * and the validator's issues. Null when the project has no manifest file. A
 * YAML syntax error is an issue, not a throw; a git read failure throws.
 */
async function readManifestForCompile(
  project: GitBackedProject,
  ref: string,
  options: CompileReadOptions,
): Promise<{ usable: Record<string, unknown>; issues: ManifestIssue[]; found: { commit: string | null; path: string; legacy?: { overlay: Record<string, string> } } } | null> {
  const found = await readManifestFromRepo(project, manifestCandidatePaths(project.manifestPath), ref, {
    forceRefresh: options.forceRefresh,
  });
  if (!found) return null;
  // The root text carries line numbers; a merged `imports:` document, and a converted legacy file, have none to give.
  const { parsed, issues } = validateManifest(found.legacy ? parseManifestText(found.content) : found.imports ? found.imports.raw : found.content);
  const usable = usableManifest(parsed, issues);
  options.onManifest?.(usable);
  return { usable, issues, found };
}

/**
 * Read a project's manifest straight from git + compile it (I/O half). The
 * compiled config, JSON-stringified (the shape `KORTIX_COMPILED_AGENT_CONFIG`
 * carries), or `null` when the project has no manifest file. Manifest content
 * never fails it: what the project applies is compiled and the issues ride in
 * `manifest_issues`. A git read failure throws, so a reload keeps the config
 * the session has instead of a confident "up to date".
 */
export async function resolveCompiledAgentConfigForSession(
  project: GitBackedProject,
  /**
   * The ref this SESSION runs on (`project_sessions.base_ref`), when it differs
   * from the project default.
   *
   * Without it every session compiled from `defaultBranch`, so a session started
   * on a feature branch ran main's agent config from its very first turn — you
   * could edit an agent, push the branch, start a session on it, and watch the
   * agent behave exactly as before. That reads as "the config never reloads",
   * but nothing had gone stale: the branch's config was never read at all.
   *
   * Falls back to the default branch, which is what every caller got before.
   */
  baseRef?: string | null,
  options: CompileReadOptions = {},
): Promise<string | null> {
  const ref = baseRef?.trim() || project.defaultBranch;
  const read = await readManifestForCompile(project, ref, options);
  if (!read) return null;
  const key = commitKey(project, read.found, '*');
  const hit = compiledAt(key);
  if (hit) return hit.compiled;
  // Every file is read at the commit the manifest came from: a sha read
  // needs no mirror fetch, and all files come from one commit.
  const compiled = JSON.stringify(compileAgentConfig(read.usable, await readPromptFiles(project, read.usable, read.found.commit ?? ref, read.found.legacy?.overlay), [...read.issues]));
  rememberCompiled(key, { raw: read.usable, compiled });
  return compiled;
}

/**
 * Resolve one selected agent for a restricted session. A project without a
 * manifest, and a selected agent that is missing or off, throw
 * `CompileAgentConfigError` naming the cause.
 */
export async function resolveSelectedAgentConfigForSession(
  project: GitBackedProject,
  agentName: string,
  baseRef?: string | null,
  options: CompileReadOptions = {},
): Promise<string> {
  const ref = baseRef?.trim() || project.defaultBranch;
  const read = await readManifestForCompile(project, ref, options);
  if (!read) {
    throw new CompileAgentConfigError(
      `Project ${project.projectId} has no manifest for selected-agent compilation.`,
      agentName,
    );
  }
  const block = mapOf<AgentBlockV3>(read.usable.agents)[agentName];
  if (!block || block.enabled === false) {
    // Unknown keys are ignored at run time: they never explain why an agent is off.
    const errors = read.issues.filter((i) => i.severity === 'error' && !i.unknownKey);
    const own = errors.filter((i) => i.path === `agents.${agentName}` || i.path.startsWith(`agents.${agentName}.`));
    const cause = own.length > 0 ? own : errors;
    throw new CompileAgentConfigError(
      `Agent "${agentName}" is ${block ? 'off' : 'not declared'}. ${manifestIssueSummary(cause)}`.trim(),
      agentName,
    );
  }
  const key = commitKey(project, read.found, `agent:${agentName}`);
  const hit = compiledAt(key);
  if (hit?.compiled) return hit.compiled;
  // Read at the manifest's own commit, as the full compile does.
  const compiled = JSON.stringify(compileSelectedAgentConfig(read.usable, agentName, await readPromptFiles(project, read.usable, read.found.commit ?? ref, read.found.legacy?.overlay), [...read.issues]));
  rememberCompiled(key, { raw: read.usable, compiled });
  return compiled;
}
