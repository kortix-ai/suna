/**
 * Compile YAML agent configuration or legacy Markdown into the runtime contract.
 * The selected-agent path pins every input to the session source revision and
 * fails closed. The all-agent resolver retains null-on-failure only for legacy
 * Markdown declarations; explicit YAML configuration failures propagate.
 * Platform grants remain separate; enabled and skill permissions overlay behavior.
 */
import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import {
  AGENT_BEHAVIOR_KEYS,
  manifestConfigDir,
  manifestDefaultRuntime,
  manifestUsesAgentMap,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  validateManifest,
  validateAgentMdFrontmatter,
  validateAgentConfiguration,
  type AgentBlockV2,
  type GrantSetV2,
  type ManifestIssue,
  type ManifestV2,
  type PermissionActionV2,
  type PermissionConfigObjectV2,
  type PermissionConfigV2,
  type PermissionRuleV2,
  type RuntimeV2,
} from '@kortix/manifest-schema';
import { parseAgentMarkdown } from './agent-markdown';
import { readAgentPrompt } from './read-agent-prompt';
import {
  isRepoFileNotFoundError,
  readManifestFromRepo,
  readRepoFile,
  type GitBackedProject,
} from '../git';

/** OpenCode's per-agent `AgentConfig` — the compiled shape for one `agent.<name>` entry. */
export interface OpencodeAgentConfig {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  /** The agent's `.md` body (frontmatter stripped) — its system prompt. */
  prompt?: string;
  disable?: boolean;
  hidden?: boolean;
  options?: Record<string, unknown>;
  color?: string;
  steps?: number;
  permission?: PermissionConfigV2;
}

/** The compiled OpenCode config fragment `compileAgentConfig` produces. */
export interface OpencodeConfig {
  /** Top-level default model passthrough — the manifest's `default_agent`'s
   *  compiled model (from ITS `.md` frontmatter), so a brand-new session (no
   *  agent picked yet) starts on the same model its default agent would
   *  resolve to. Omitted when the default agent declares no model (the
   *  platform/account default applies, same as today). */
  model?: string;
  /** No compiled field maps to a top-level `small_model` today — passthrough
   *  is a no-op until one exists. Reserved so a future field has somewhere to
   *  land without another signature change. */
  small_model?: string;
  agent: Record<string, OpencodeAgentConfig>;
}

/** Raised when a v2 manifest can't be compiled — a genuine authoring error
 *  (malformed `.md` frontmatter, unsupported runtime), not a transient I/O
 *  failure. */
export class CompileAgentConfigError extends Error {
  constructor(
    message: string,
    public readonly agent?: string,
  ) {
    super(message);
    this.name = 'CompileAgentConfigError';
  }
}

/** Tolerant `kortix_version` read — mirrors apps/api's own manifest readers
 *  (e.g. `parseManifestString` in projects/triggers.ts), which coerce a
 *  string version too. Real YAML/TOML decode `kortix_version: 2` to a native
 *  number; the string branch is defensive only. */
function manifestSchemaVersion(manifest: Record<string, unknown>): number {
  const raw = manifest.kortix_version;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  return Number.NaN;
}

/**
 * Where this project's agents/skills/commands live — "where does
 * `<config_dir>/agents/...` live for this project", unrelated to per-agent
 * behavior.
 *
 * The default follows the manifest's own version: `.kortix/pi` from v3,
 * `.kortix/opencode` before it. A v3 project's agents should not sit in a
 * directory named after the runtime it does not run.
 *
 * `pi:` is read before `opencode:` so a v3 manifest can name its own directory
 * without borrowing the other runtime's block; a v3 manifest that still sets
 * `opencode: config_dir` is honoured rather than ignored, because that is a
 * deliberate statement about where the files are and silently reading a
 * different path would lose them.
 */
function resolveConfigDir(manifest: Record<string, unknown>): string {
  return manifestConfigDir(manifest);
}

/** The explicit prompt file, or the legacy agent Markdown path. */
export function agentMarkdownPath(manifest: Record<string, unknown>, agentName: string): string {
  const prompt = (manifest.agents as Record<string, AgentBlockV2> | undefined)?.[agentName]?.config?.prompt;
  if (prompt && typeof prompt === 'object' && typeof prompt.file === 'string') return prompt.file;
  return `${resolveConfigDir(manifest)}/agents/${agentName}.md`;
}

function needsAgentFile(manifest: Record<string, unknown>, agentName: string): boolean {
  const config = (manifest.agents as Record<string, AgentBlockV2> | undefined)?.[agentName]?.config;
  return config === undefined || typeof config?.prompt === 'object';
}

/** Behavioral frontmatter keys copied straight through onto the compiled
 *  OpenCode agent config — full `AgentConfig` parity, 1:1 by name. This is
 *  the CANONICAL list: the agent-config editor route derives its own
 *  `KNOWN_BEHAVIOR_KEYS` (this list minus `disable`, which the editor never
 *  round-trips) and its wire schema from it, instead of hand-maintaining a
 *  second/third copy — see `routes/agent-config.ts`. */
export const BEHAVIOR_FRONTMATTER_KEYS = AGENT_BEHAVIOR_KEYS;

/** The agent-config editor's round-tripped subset of `BEHAVIOR_FRONTMATTER_KEYS`
 *  — every field except `disable`, which the editor never round-trips (a
 *  hand-authored `disable` already in the `.md` passes through untouched
 *  instead — see `routes/agent-config.ts`'s `mergeFrontmatter`). A derivation,
 *  not a second hand-maintained literal, so the editor's merge/GET-projection
 *  key set can't silently drift from the compiler's. */
export const KNOWN_BEHAVIOR_KEYS = BEHAVIOR_FRONTMATTER_KEYS.filter(
  (key): key is Exclude<(typeof BEHAVIOR_FRONTMATTER_KEYS)[number], 'disable'> => key !== 'disable',
);

/** The agent-config editor's wire schema for the `opencode` (BEHAVIOR) half of
 *  a PUT body — one field per `KNOWN_BEHAVIOR_KEYS` entry, typed for its real
 *  frontmatter shape (a generic per-key schema can't express "temperature is
 *  a number, permission is a tree, model is a string" from a flat string
 *  array), PLUS `prompt` (the `.md` BODY, not a frontmatter key — see
 *  `OpencodeAgentConfig.prompt` above). Kept beside `KNOWN_BEHAVIOR_KEYS`
 *  rather than re-declared in the route so the two are visibly one thing;
 *  `compile-agent-config.test.ts`'s coordination test fails loudly the moment
 *  a field is added to one without the other. */
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
 * Compile a manifest's declared agents into an OpenCode-native config.
 *
 * `manifest` is the raw parsed object (TOML/YAML decode to the same shape —
 * see `@kortix/manifest-schema`'s format layer), not necessarily typed as
 * `ManifestV2` by the caller: this function itself is the version gate.
 *
 * Returns `null` for anything that isn't a `kortix_version: 2` manifest — the
 * compiler is a v1 NO-OP by design (spec §2.3: "v2-only feature"), so v1
 * projects keep depending on hand-authored `.md` frontmatter exactly as before
 * (v1 never had a manifest-side behavior representation to move out of).
 *
 * `agentMdFiles` maps an agent's conventional `.md` path (see
 * `agentMarkdownPath`) to that file's raw text content (as read from the
 * project's repo). When an agent's file is present, its frontmatter is
 * validated (throws `CompileAgentConfigError` on a malformed field — bad
 * enum, non-numeric temperature, broken permission tree) and copied through;
 * the body (frontmatter stripped) becomes `prompt`. When the file is ABSENT
 * from the map (caller didn't/couldn't read it — e.g. the agent has no `.md`
 * yet), the agent compiles with governance only (no behavior fields, no
 * throw) — callers that can read the repo (the session-env wiring below)
 * should always populate this map for every declared agent.
 */
export function compileAgentConfig(
  manifest: Record<string, unknown>,
  runtime: RuntimeV2 = 'opencode',
  agentMdFiles: Record<string, string> = {},
): OpencodeConfig | null {
  if (!manifestUsesAgentMap(manifestSchemaVersion(manifest))) return null;

  if (runtime !== 'opencode') {
    throw new CompileAgentConfigError(
      `Unsupported compiler runtime "${runtime}" — only "opencode" is implemented today.`,
    );
  }

  const v2 = manifest as unknown as ManifestV2;
  const rawAgents =
    v2.agents && typeof v2.agents === 'object' && !Array.isArray(v2.agents) ? v2.agents : {};

  const agent: Record<string, OpencodeAgentConfig> = {};
  for (const [name, block] of Object.entries(rawAgents)) {
    const mdPath = agentMarkdownPath(manifest, name);
    agent[name] = compileAgentBlock(name, block, mdPath, agentMdFiles[mdPath]);
  }

  const defaultAgentName = typeof v2.default_agent === 'string' ? v2.default_agent : undefined;
  const defaultModel = defaultAgentName ? agent[defaultAgentName]?.model : undefined;

  return {
    ...(defaultModel ? { model: defaultModel } : {}),
    agent,
  };
}

/** Compile one selected v2 agent for a restricted session environment. */
export function compileSelectedAgentConfig(
  manifest: Record<string, unknown>,
  agentName: string,
  runtime: RuntimeV2 = 'opencode',
  agentMdFiles: Record<string, string> = {},
): OpencodeConfig {
  if (!manifestUsesAgentMap(manifestSchemaVersion(manifest))) {
    throw new CompileAgentConfigError('Selected-agent compilation requires kortix_version 2 or later.');
  }
  if (runtime !== 'opencode') {
    throw new CompileAgentConfigError(
      `Unsupported compiler runtime "${runtime}" — only "opencode" is implemented today.`,
    );
  }

  const v2 = manifest as unknown as ManifestV2;
  const rawAgents =
    v2.agents && typeof v2.agents === 'object' && !Array.isArray(v2.agents)
      ? v2.agents
      : {};
  // Key presence, not truthiness: a declared agent may legitimately have a
  // null block (comments only), and that is NOT "undeclared".
  if (!Object.hasOwn(rawAgents, agentName)) {
    throw new CompileAgentConfigError(`Agent "${agentName}" is not declared.`, agentName);
  }
  const block: AgentBlockV2 = rawAgents[agentName] ?? ({} as AgentBlockV2);
  if (block.enabled === false) {
    throw new CompileAgentConfigError(`Agent "${agentName}" is disabled.`, agentName);
  }

  const mdPath = agentMarkdownPath(manifest, agentName);
  const compiledAgent = compileAgentBlock(agentName, block, mdPath, agentMdFiles[mdPath]);
  return {
    ...(compiledAgent.model ? { model: compiledAgent.model } : {}),
    agent: { [agentName]: compiledAgent },
  };
}

/**
 * Compile one agent: parse its `.md` (if supplied), copy every recognized
 * behavioral frontmatter field through unchanged, then overlay Kortix
 * governance — `enabled: false` forces `disable: true` (the one field where
 * governance always wins over whatever the `.md` itself says; there is no
 * other precedence to document since behavior lives ONLY in the `.md`), and
 * `skills` folds onto `permission.skill`. Pure governance fields (connectors/
 * secrets/kortix_cli/repository_access) are never copied: no runtime representation.
 */
function compileAgentBlock(
  name: string,
  rawBlock: AgentBlockV2 | null | undefined,
  mdPath: string,
  mdContent: string | undefined,
): OpencodeAgentConfig {
  // A declared agent whose block holds only comments parses as NULL in YAML:
  //
  //   echo-probe:
  //     # grants nothing
  //
  // That is a legitimate declaration — the agent exists and grants nothing —
  // but it used to reach `block.enabled` and throw, and this compile is
  // ALL-OR-NOTHING: one such agent took down the whole project's config, so
  // every session booted with no compiled agent config at all and the
  // per-agent prebuild fell back to the default agent alone. Seen on
  // pi.kortix.com 2026-08-29: "null is not an object (evaluating
  // 'block.enabled')".
  const block: AgentBlockV2 = rawBlock ?? ({} as AgentBlockV2);
  const out: OpencodeAgentConfig = {};

  if (block.config !== undefined) {
    const issues: ManifestIssue[] = [];
    validateAgentConfiguration(block.config, `agents.${name}.config`, issues, validateAgentMdFrontmatter);
    const errors = issues.filter(issue => issue.severity === 'error');
    if (errors.length) throw new CompileAgentConfigError(errors.map(issue => `${issue.path}: ${issue.message}`).join('; '), name);
    for (const key of BEHAVIOR_FRONTMATTER_KEYS)
      if (block.config[key] !== undefined) (out as Record<string, unknown>)[key] = block.config[key];
    if (typeof block.config.prompt === 'string') out.prompt = block.config.prompt;
    else if (block.config.prompt) {
      if (mdContent === undefined) throw new CompileAgentConfigError(`Agent "${name}" prompt file "${mdPath}" is missing.`, name);
      out.prompt = mdContent;
    }
  } else if (mdContent !== undefined) {
    const { frontmatter, body } = parseAgentMarkdown(mdContent);

    const issues: ManifestIssue[] = [];
    validateAgentMdFrontmatter(frontmatter, `agents.${name}`, issues);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new CompileAgentConfigError(
        `Agent "${name}"'s behavior file "${mdPath}" has invalid frontmatter: ` +
          errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        name,
      );
    }

    for (const key of BEHAVIOR_FRONTMATTER_KEYS) {
      if (frontmatter[key] !== undefined) {
        (out as Record<string, unknown>)[key] = frontmatter[key];
      }
    }
    if (body.trim()) out.prompt = body;
  }

  // Kortix `enabled: false` always forces the runtime's `disable` on — the
  // one platform-level "can this agent even start a session" gate. When
  // `enabled` is omitted (the default, true), whatever the `.md` itself set
  // for `disable` (if anything) passes through untouched above.
  if (block.enabled === false) out.disable = true;

  if (block.skills !== undefined) {
    out.permission = applySkillsGovernance(out.permission, block.skills);
  }

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
 * Turn a `skills` grant set (names | "all" | "none") into the `permission.skill`
 * rule OpenCode actually enforces: a bare action when uniform (all-allow /
 * all-deny), or a glob-pattern map (each named skill → allow, `"*"` → deny)
 * when it's a specific allowlist. Empty list behaves like "none" (deny
 * everything) — an author who picked "specific skills" and selected nothing
 * gets the safe (deny) reading, not an accidental "all".
 */
function skillsGrantToPermissionRule(skills: GrantSetV2): PermissionRuleV2 {
  if (skills === 'all') return 'allow';
  if (skills === 'none' || skills.length === 0) return 'deny';
  const rule: Record<string, PermissionActionV2> = {};
  for (const name of skills) rule[name] = 'allow';
  rule['*'] = 'deny';
  return rule;
}

/**
 * Merge the `skills` governance grant's computed `permission.skill` rule into
 * whatever `permission` the agent's `.md` frontmatter already set.
 *
 * PRECEDENCE (documented, deliberate): when `skills` is set on the manifest
 * block, it OWNS the `skill` key outright — it overrides any hand-authored
 * `permission.skill` rule in the `.md`, the same "governance wins" posture
 * `enabled`→`disable` has. An author who omits `skills` entirely keeps full
 * manual control over `permission.skill` (this function is never called in
 * that case — see `compileAgentBlock`), so a hand-rolled per-skill glob rule
 * in the `.md` remains a supported escape hatch for anyone not using the
 * governance picker.
 */
function applySkillsGovernance(
  base: PermissionConfigV2 | undefined,
  skills: GrantSetV2,
): PermissionConfigV2 {
  const skillRule = skillsGrantToPermissionRule(skills);
  if (base === undefined) return { skill: skillRule };
  if (typeof base === 'string') {
    // A bare whole-agent action (e.g. `permission: allow`) applies to every
    // capability including `skill` — expand it into an explicit object so
    // overriding `skill` doesn't silently drop the author's intent for
    // everything else.
    const expanded: PermissionConfigObjectV2 = {};
    for (const key of OTHER_PERMISSION_KEYS) expanded[key] = base as PermissionActionV2;
    expanded.skill = skillRule;
    return expanded;
  }
  return { ...base, skill: skillRule };
}

/**
 * Read a project's manifest straight from git + compile it (I/O half). Never
 * throws: any read/parse/compile failure resolves to `null` so a broken or
 * mid-migration manifest never blocks session provisioning — a manifest or
 * `.md` authoring error should surface at `kortix validate` / CR-merge time,
 * not by failing a session boot months later.
 *
 * Returns the compiled config already JSON-stringified (the shape
 * `KORTIX_COMPILED_AGENT_CONFIG` carries), or `null` for a v1 project / no
 * manifest / any failure.
 */
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

/** Resolve a session runtime while preserving only deliberate legacy absence. */
export async function resolveManifestRuntimeForPiSession(
  project: GitBackedProject,
  baseRef?: string | null,
): Promise<RuntimeV2 | null> {
  const ref = baseRef?.trim() || project.defaultBranch;
  const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
  const found = await readManifestFromRepo(project, candidates, ref);
  if (!found) return null;
  const raw = parseManifestText(found.content, manifestFormatForPath(found.path));
  const version = manifestSchemaVersion(raw);
  if (version === 1) return null;
  if (version !== 2 && version !== 3) {
    throw new CompileAgentConfigError('Manifest must declare a valid kortix_version.');
  }
  const runtime = (raw as Record<string, unknown>).runtime;
  if (runtime !== undefined && runtime !== 'pi' && runtime !== 'opencode') {
    throw new CompileAgentConfigError('Manifest runtime must be "pi" or "opencode".');
  }
  const expected = manifestDefaultRuntime(version);
  if (runtime !== undefined && runtime !== expected) {
    throw new CompileAgentConfigError(`kortix_version ${version} requires runtime "${expected}".`);
  }
  return expected;
}

/**
 * The manifest's declared session runtime at a ref: 'pi' | 'opencode' | null.
 *
 * This compatibility resolver keeps the historical tolerant contract. Session
 * creation for a Pi-enabled project uses `resolveManifestRuntimeForPiSession`
 * so Git, parse, and invalid-runtime failures cannot silently select OpenCode.
 */
export async function resolveManifestRuntime(
  project: GitBackedProject,
  baseRef?: string | null,
): Promise<RuntimeV2 | null> {
  try {
    return await resolveManifestRuntimeForPiSession(project, baseRef);
  } catch {
    return null;
  }
}

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
): Promise<string | null> {
  const ref = baseRef?.trim() || project.defaultBranch;
  let hasExplicitConfiguration = false;
  try {
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    const found = await readManifestFromRepo(project, candidates, ref);
    if (!found) return null;

    const format = manifestFormatForPath(found.path);
    const raw = parseManifestText(found.content, format);
    if (!manifestUsesAgentMap(manifestSchemaVersion(raw))) return null;

    const v2 = raw as unknown as ManifestV2;
    const agents =
      v2.agents && typeof v2.agents === 'object' && !Array.isArray(v2.agents) ? v2.agents : {};

    hasExplicitConfiguration = Object.values(agents).some(block => block?.config !== undefined);
    const agentMdFiles: Record<string, string> = {};
    await Promise.all(
      Object.keys(agents).map(async (name) => {
        if (!needsAgentFile(raw, name)) return;
        const path = agentMarkdownPath(raw, name);
        try {
          agentMdFiles[path] = agents[name]?.config !== undefined
            ? await readAgentPrompt(project, path, ref)
            : await readRepoFile(project, path, ref);
        } catch (err) {
          // A MISSING file is an expected client condition: the manifest may
          // declare an agent that carries no behavior file, and that agent
          // simply compiles without one.
          //
          // Anything else — a git operation error, a blip through the proxy — is
          // not, and swallowing it silently compiles the agent with NO prompt,
          // model, or permissions. That is a lobotomised agent reported as a
          // successful reload, with a fresh etag saying it is current. Rethrow
          // so the outer catch returns null: the session keeps the config it has
          // and `stale` reads null ("could not tell") rather than a confident
          // and wrong "up to date".
          if (!isRepoFileNotFoundError(err)) throw err;
          console.warn(
            `[compile-agent-config] project ${project.projectId}: agent "${name}" has no behavior file at "${path}"`,
          );
        }
      }),
    );

    const compiled = compileAgentConfig(raw, 'opencode', agentMdFiles);
    return compiled ? JSON.stringify(compiled) : null;
  } catch (err) {
    if (hasExplicitConfiguration) throw err;
    console.warn(
      `[compile-agent-config] project ${project.projectId}: compile failed, session boots without a compiled agent config: ${(err as Error).message}`,
    );
    return null;
  }
}

/** Resolve one selected agent for a restricted session. Every failure is fatal. */
export async function resolveSelectedAgentConfigForSession(
  project: GitBackedProject,
  agentName: string,
  baseRef?: string | null,
): Promise<string> {
  const ref = baseRef?.trim() || project.defaultBranch;
  const candidates = manifestCandidatePaths(project.manifestPath).map(
    (candidate) => candidate.path,
  );
  const found = await readManifestFromRepo(project, candidates, ref);
  if (!found) {
    throw new CompileAgentConfigError(
      `Project ${project.projectId} has no manifest for selected-agent compilation.`,
      agentName,
    );
  }

  const format = manifestFormatForPath(found.path);
  const raw = parseManifestText(found.content, format);
  if (!manifestUsesAgentMap(manifestSchemaVersion(raw))) {
    throw new CompileAgentConfigError(
      `Project ${project.projectId} must use kortix_version 2 or later for selected-agent compilation.`,
      agentName,
    );
  }

  const manifest = raw as unknown as ManifestV2;
  const rawAgents =
    manifest.agents && typeof manifest.agents === 'object' && !Array.isArray(manifest.agents)
      ? manifest.agents
      : {};
  if (Object.hasOwn(rawAgents, agentName)) {
    const selectedValidation = validateManifest(
      {
        kortix_version: manifestSchemaVersion(raw),
        default_agent: agentName,
        agents: { [agentName]: rawAgents[agentName] ?? {} },
      },
      format,
    );
    const errors = selectedValidation.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      throw new CompileAgentConfigError(
        `Agent "${agentName}" has invalid governance: ${errors
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
        agentName,
      );
    }
  }

  const path = agentMarkdownPath(raw, agentName);
  const agentMdFiles: Record<string, string> = {};
  if (needsAgentFile(raw, agentName)) {
    try {
      agentMdFiles[path] = rawAgents[agentName]?.config !== undefined
        ? await readAgentPrompt(project, path, ref)
        : await readRepoFile(project, path, ref);
    } catch (err) {
      if (!isRepoFileNotFoundError(err)) throw err;
    }
  }

  return JSON.stringify(compileSelectedAgentConfig(raw, agentName, 'opencode', agentMdFiles));
}
