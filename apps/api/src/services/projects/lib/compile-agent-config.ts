/**
 * The runtime compiler (redirected 2026-07-05 — "one home per concern"): turns a
 * `kortix_version: 2` manifest's `agents:` map (pure governance) plus each
 * agent's own `.md` (frontmatter + body — the behavior source of truth;
 * `agents.<name>.file`, default `agents/<name>.md`) into OpenCode-native config.
 *
 * The 2026-07-05 redirect killed the earlier "nested `opencode:` block in
 * kortix.yaml + illegal-frontmatter gate" design: OpenCode behavior
 * (mode/model/temperature/top_p/steps/variant/color/hidden/permission/prompt)
 * now lives ENTIRELY in the agent's own `.md` frontmatter + body — a stock
 * OpenCode agent `.md` is valid input as-is, frontmatter included. The
 * manifest's `agents.<name>` block carries governance ONLY (connectors/
 * secrets/skills/kortix_permissions/repository_access/enabled) plus `file`, the path of the
 * agent's `.md`; without `file` the agent's NAME is the join (map key ↔ `.md` filename).
 *
 * v3 compiles agent behavior directly from kortix.yaml, with optional prompt_file;
 * v2 still loads native agent Markdown and v1 stays untouched.
 *
 * `compileAgentConfig` is pure — no I/O, no DB. For each declared agent it
 * parses that agent's `.md` content (supplied by the caller, keyed by the
 * candidate path — see `agentFileCandidates`), copies every recognized
 * OpenCode behavioral field straight through, and overlays governance on top:
 * `enabled: false` forces the runtime's `disable` on (governance always wins
 * on that one field); `skills` folds onto `permission.skill`. Every other
 * governance field (connectors/secrets/kortix_permissions/repository_access) has no runtime
 * representation and is never copied.
 *
 * `resolveCompiledAgentConfigForSession` is the I/O half: reads the project's
 * manifest + each declared agent's `.md` straight from git (bypassing apps/api's
 * v1-only `triggers.ts` manifest reader, which still caps at `kortix_version`
 * 1 — this compiler is the first apps/api consumer of a v2 manifest's `agents:`
 * map, so it reads the raw text itself via `@kortix/manifest-schema` rather
 * than waiting on that cap to move). It never throws: a v1 project (or any
 * read/parse/compile failure) resolves to `null`, which is the "v1 byte-for-
 * byte unaffected" contract the session-env wiring depends on.
 */
import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { CompiledAgent, CompiledAgentSet } from '@kortix/api-contract/runtime-relay';
import {
  agentFileCandidates,
  defaultAgentFile,
  safeAgentFile,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  validateAgentMdFrontmatter,
  validateManifest,
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
import {
  isRepoFileNotFoundError,
  readManifestFromRepo,
  readRepoFile,
  type GitBackedProject,
  type MirrorRefresh,
} from '../../git';

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
 * or a subagent, which cannot run as the primary.
 */
type CompiledAgents = CompiledAgentSet & { agent: Record<string, CompiledAgentEntry> };

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
 *  (e.g. `parseManifestString` in services/triggers/index.ts), which coerce a
 *  string version too. Real YAML/TOML decode `kortix_version: 2` to a native
 *  number; the string branch is defensive only. */
function manifestSchemaVersion(manifest: Record<string, unknown>): number {
  const raw = manifest.kortix_version;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  return Number.NaN;
}

/**
 * Where a NEW or edited agent `.md` is written: its `agents.<name>.file`, else
 * `agents/<name>.md`. Reading an existing agent goes through
 * `agentFileCandidates` instead, which also finds the legacy
 * `.kortix/opencode/agents/<name>.md`.
 */
export function agentMarkdownPath(manifest: Record<string, unknown>, agentName: string): string {
  return agentFileCandidates(manifest, agentName)[0] ?? defaultAgentFile(agentName);
}

/** The first candidate path the caller could read, so compile uses the file that exists. */
function suppliedAgentMarkdown(
  manifest: Record<string, unknown>,
  agentName: string,
  agentMdFiles: Record<string, string>,
): { path: string; content: string | undefined } {
  const path =
    agentFileCandidates(manifest, agentName).find((candidate) => candidate in agentMdFiles) ??
    agentMarkdownPath(manifest, agentName);
  return { path, content: agentMdFiles[path] };
}

/**
 * Read an agent's `.md` at `ref`: the first candidate that exists. When none
 * exists, `path` is where the file would be written and `content` is null.
 * Only a missing file is tolerated; any other git error throws.
 */
export async function readAgentMarkdownFile(
  project: GitBackedProject,
  manifest: Record<string, unknown>,
  agentName: string,
  ref: string,
): Promise<{ path: string; content: string | null }> {
  for (const path of agentFileCandidates(manifest, agentName)) {
    try {
      return { path, content: await readRepoFile(project, path, ref) };
    } catch (err) {
      if (!isRepoFileNotFoundError(err)) throw err;
    }
  }
  return { path: agentMarkdownPath(manifest, agentName), content: null };
}

/** Behavioral frontmatter keys copied straight through onto the compiled
 *  OpenCode agent config — full `AgentConfig` parity, 1:1 by name. This is
 *  the CANONICAL list: the agent-config editor route derives its own
 *  `KNOWN_BEHAVIOR_KEYS` (this list minus `disable`, which the editor never
 *  round-trips) and its wire schema from it, instead of hand-maintaining a
 *  second/third copy — see `routes/agent-config.ts`. */
export const BEHAVIOR_FRONTMATTER_KEYS = [
  'description',
  'mode',
  'model',
  'variant',
  'temperature',
  'top_p',
  'options',
  'color',
  'steps',
  'hidden',
  'permission',
  'disable',
] as const;

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
 *  `CompiledAgentEntry.prompt` above). Kept beside `KNOWN_BEHAVIOR_KEYS`
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
 * Returns `null` for v1 or unknown versions; v2/v3 compile into the same
 * harness-independent environment contract. The
 * compiler is a v1 NO-OP by design (spec §2.3: "v2-only feature"), so v1
 * projects keep depending on hand-authored `.md` frontmatter exactly as before
 * (v1 never had a manifest-side behavior representation to move out of).
 *
 * `agentMdFiles` maps an agent's `.md` path (any of its
 * `agentFileCandidates`; the first one present wins) to that file's raw text content (as read from the
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
): CompiledAgents | null {
  if (![2, 3].includes(manifestSchemaVersion(manifest))) return null;

  if (runtime !== 'opencode') {
    throw new CompileAgentConfigError(
      `Unsupported compiler runtime "${runtime}" — only "opencode" is implemented today.`,
    );
  }

  const v2 = manifest as unknown as ManifestV2;
  const rawAgents =
    v2.agents && typeof v2.agents === 'object' && !Array.isArray(v2.agents) ? v2.agents : {};

  const agent: Record<string, CompiledAgentEntry> = {};
  for (const [name, block] of Object.entries(rawAgents)) {
    const md = manifestSchemaVersion(manifest) === 3 ? null : suppliedAgentMarkdown(manifest, name, agentMdFiles);
    agent[name] = md
      ? compileAgentBlock(name, block, md.path, md.content)
      : compileYamlAgentBlock(name, block, agentMdFiles);
  }

  const defaultAgentName = typeof v2.default_agent === 'string' ? v2.default_agent : undefined;
  const defaultAgent = defaultAgentName ? agent[defaultAgentName] : undefined;
  const defaultModel = defaultAgent?.model;
  const runnableDefault = defaultAgent && !defaultAgent.disable && defaultAgent.mode !== 'subagent';

  return {
    ...(defaultModel ? { model: defaultModel } : {}),
    ...(runnableDefault ? { default_agent: defaultAgentName } : {}),
    agent,
  };
}

/** Compile one selected v2 agent for a restricted session environment. */
export function compileSelectedAgentConfig(
  manifest: Record<string, unknown>,
  agentName: string,
  runtime: RuntimeV2 = 'opencode',
  agentMdFiles: Record<string, string> = {},
): CompiledAgents {
  if (![2, 3].includes(manifestSchemaVersion(manifest))) {
    throw new CompileAgentConfigError('Selected-agent compilation requires kortix_version 2 or 3.');
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
  const block = rawAgents[agentName];
  if (!block) {
    throw new CompileAgentConfigError(`Agent "${agentName}" is not declared.`, agentName);
  }
  if (block.enabled === false) {
    throw new CompileAgentConfigError(`Agent "${agentName}" is disabled.`, agentName);
  }

  let compiledAgent: CompiledAgentEntry;
  if (manifestSchemaVersion(manifest) === 3) {
    compiledAgent = compileYamlAgentBlock(agentName, block, agentMdFiles);
  } else {
    const md = suppliedAgentMarkdown(manifest, agentName, agentMdFiles);
    compiledAgent = compileAgentBlock(agentName, block, md.path, md.content);
  }
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
 * secrets/kortix_permissions/repository_access) are never copied: no runtime representation.
 */
function compileYamlAgentBlock(
  name: string,
  block: AgentBlockV2,
  files: Record<string, string>,
): CompiledAgentEntry {
  const raw = block as Record<string, unknown>;
  const issues: ManifestIssue[] = [];
  validateAgentMdFrontmatter(raw, `agents.${name}`, issues);
  if (raw.prompt !== undefined && typeof raw.prompt !== 'string') {
    issues.push({ path: `agents.${name}.prompt`, message: 'must be a string.', severity: 'error' });
  }
  if (raw.file !== undefined || raw.opencode !== undefined || raw.disable !== undefined) {
    issues.push({ path: `agents.${name}`, message: 'v3 does not accept native agent config fields.', severity: 'error' });
  }
  if (raw.prompt_file !== undefined &&
      (!safeAgentFile(raw.prompt_file) || typeof raw.prompt_file !== 'string' || !(raw.prompt_file in files) || raw.prompt !== undefined)) {
    issues.push({ path: `agents.${name}.prompt_file`, message: 'prompt file must be a safe, readable repo-relative .md file and cannot conflict with inline prompt.', severity: 'error' });
  }
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new CompileAgentConfigError(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '), name);
  }
  const compiled: CompiledAgentEntry = {};
  for (const key of BEHAVIOR_FRONTMATTER_KEYS) {
    if (raw[key] !== undefined) (compiled as Record<string, unknown>)[key] = raw[key];
  }
  const prompt = typeof raw.prompt_file === 'string' ? files[raw.prompt_file] : raw.prompt;
  if (typeof prompt === 'string') compiled.prompt = prompt;
  if (block.enabled === false) compiled.disable = true;
  if (block.skills !== undefined) compiled.permission = applySkillsGovernance(compiled.permission, block.skills);
  if (compiled.permission !== undefined) compiled.permission = denyToolsBehindDeniedPermission(compiled.permission);
  return compiled;
}

function compileAgentBlock(
  name: string,
  block: AgentBlockV2,
  mdPath: string,
  mdContent: string | undefined,
): CompiledAgentEntry {
  const out: CompiledAgentEntry = {};

  if (mdContent !== undefined) {
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
  if (block.tools !== undefined) out.tools = block.tools;

  if (block.skills !== undefined) {
    out.permission = applySkillsGovernance(out.permission, block.skills);
  }
  if (out.permission !== undefined) out.permission = denyToolsBehindDeniedPermission(out.permission);

  return out;
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

/**
 * The manifest's declared session runtime at a ref: 'pi' | 'opencode' | null.
 *
 * Null means "could not tell" (no manifest, not v2, read/parse failure) and
 * always falls back to the OpenCode path — the same fail-open-to-legacy
 * posture as resolveCompiledAgentConfigForSession below. Only an explicit,
 * well-formed `runtime: pi` can move a session onto the worker.
 */
/**
 * The harness a session boots, from the two inputs that can ask for pi:
 * the project's `pi_harness` feature flag (on ⇒ pi, whatever the manifest
 * says) and the manifest's `runtime:` field (`pi` ⇒ pi, even with the flag
 * off). Everything else is OpenCode. `runtime: null` is "no readable v2
 * manifest", which counts as opencode.
 *
 * pi calls models only through the Kortix LLM gateway (kortixd
 * `harness/pi/model.ts`). A project with the `llm_gateway` flag off gets no
 * gateway URL, so it always boots OpenCode, which calls providers directly.
 */
export function selectSessionHarness(input: {
  piHarnessFlag: boolean;
  runtime: RuntimeV2 | null;
  llmGateway: boolean;
}): 'opencode' | 'pi' {
  if (!input.llmGateway) return 'opencode';
  if (input.piHarnessFlag) return 'pi';
  return input.runtime === 'pi' ? 'pi' : 'opencode';
}

/** The harness a parsed manifest selects. `runtime` is a v2 field; anything but `pi` is OpenCode. */
export function manifestRuntime(raw: unknown): RuntimeV2 {
  if (!raw || typeof raw !== 'object' || ![2, 3].includes(manifestSchemaVersion(raw as Record<string, unknown>))) return 'opencode';
  return (raw as Record<string, unknown>).runtime === 'pi' ? 'pi' : 'opencode';
}

type PiHarness = { pi?: { packages?: unknown; exclude?: unknown } } | undefined;

function piList(harnesses: PiHarness, key: 'packages' | 'exclude'): unknown[] {
  const value = harnesses?.pi?.[key];
  return Array.isArray(value) ? value : [];
}

/** A package's identity across the two levels: its npm name, or its `./` path as written. */
function piPackageKey(entry: unknown): string | null {
  const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
  if (typeof source !== 'string') return null;
  const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@.*)?$/.exec(source);
  return npm ? npm[1]! : source;
}

/**
 * An agent's pi packages, entries as written (pi's own settings shape): the
 * top-level `harnesses.pi.packages` minus the agent's `exclude`, then the
 * agent's own `harnesses.pi.packages`; an agent entry for a package the top
 * level also lists replaces it in place. No agent name (or `default`) means `default_agent`.
 * The manifest validator gated every entry at merge; anything else reads as none.
 */
export function manifestPiPackages(raw: unknown, agentName?: string | null): unknown[] {
  if (!raw || typeof raw !== 'object' || ![2, 3].includes(manifestSchemaVersion(raw as Record<string, unknown>))) return [];
  const manifest = raw as Record<string, unknown>;
  const requested = agentName?.trim();
  // `default` is the session layer's "no agent chosen" (sessions.ts), like the runtime's.
  const name = requested && requested !== 'default' ? requested : typeof manifest.default_agent === 'string' ? manifest.default_agent : '';
  const agent = (manifest.agents as Record<string, { harnesses?: PiHarness } | undefined> | undefined)?.[name];
  const excluded = new Set(piList(agent?.harnesses, 'exclude'));
  const own = new Map(piList(agent?.harnesses, 'packages').map((entry) => [piPackageKey(entry), entry]));
  const merged = piList(manifest.harnesses as PiHarness, 'packages')
    .filter((entry) => !excluded.has(piPackageKey(entry)))
    .map((entry) => {
      const key = piPackageKey(entry);
      if (!own.has(key)) return entry;
      const replacement = own.get(key);
      own.delete(key);
      return replacement;
    });
  return [...merged, ...own.values()];
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

/** The parsed v2 manifest at `baseRef` (default branch when absent); null for v1, none, or a read failure. */
async function readManifestV2(project: GitBackedProject, baseRef?: string | null): Promise<Record<string, unknown> | null> {
  const ref = baseRef?.trim() || project.defaultBranch;
  try {
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    const found = await readManifestFromRepo(project, candidates, ref);
    if (!found) return null;
    const raw = parseManifestText(found.content, manifestFormatForPath(found.path));
    return [2, 3].includes(manifestSchemaVersion(raw)) ? raw : null;
  } catch {
    return null;
  }
}

export async function resolveManifestRuntime(
  project: GitBackedProject,
  baseRef?: string | null,
): Promise<RuntimeV2 | null> {
  const raw = await readManifestV2(project, baseRef);
  return raw ? manifestRuntime(raw) : null;
}

export async function resolveManifestPiPackageLists(project: GitBackedProject, baseRef?: string | null): Promise<unknown[][]> {
  return manifestPiPackageLists(await readManifestV2(project, baseRef));
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
  let manifestVersion: number | undefined;
  try {
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    const found = await readManifestFromRepo(project, candidates, ref, {
      forceRefresh: options.forceRefresh,
    });
    if (!found) return null;

    const format = manifestFormatForPath(found.path);
    const raw = parseManifestText(found.content, format);
    options.onManifest?.(raw as Record<string, unknown>);
    manifestVersion = manifestSchemaVersion(raw);
    if (![2, 3].includes(manifestVersion)) return null;
    if (manifestSchemaVersion(raw) === 3) {
      const validation = validateManifest(raw, format);
      if (!validation.valid) throw new CompileAgentConfigError(validation.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    }

    const v2 = raw as unknown as ManifestV2;
    const agents =
      v2.agents && typeof v2.agents === 'object' && !Array.isArray(v2.agents) ? v2.agents : {};

    const agentMdFiles: Record<string, string> = {};
    await Promise.all(
      Object.keys(agents).map(async (name) => {
        if (manifestSchemaVersion(raw) === 3) {
          const promptFile = (agents[name] as Record<string, unknown>).prompt_file;
          if (typeof promptFile === 'string') agentMdFiles[promptFile] = await readRepoFile(project, promptFile, ref);
          return;
        }
        // A MISSING file is an expected client condition: the manifest may
        // declare an agent that carries no behavior file, and that agent
        // simply compiles without one.
        //
        // Anything else — a git operation error, a blip through the proxy — is
        // not, and swallowing it silently compiles the agent with NO prompt,
        // model, or permissions. That is a lobotomised agent reported as a
        // successful reload, with a fresh etag saying it is current.
        // `readAgentMarkdownFile` rethrows it, so the outer catch returns null:
        // the session keeps the config it has and `stale` reads null ("could
        // not tell") rather than a confident and wrong "up to date".
        const md = await readAgentMarkdownFile(project, raw, name, ref);
        if (md.content !== null) {
          agentMdFiles[md.path] = md.content;
          return;
        }
        console.warn(
          `[compile-agent-config] project ${project.projectId}: agent "${name}" has no behavior file at "${md.path}"`,
        );
      }),
    );

    const compiled = compileAgentConfig(raw, 'opencode', agentMdFiles);
    return compiled ? JSON.stringify(compiled) : null;
  } catch (err) {
    console.warn(
      `[compile-agent-config] project ${project.projectId}: compile failed: ${(err as Error).message}`,
    );
    if (manifestVersion === 3) throw err;
    return null;
  }
}

/** Resolve one selected agent for a restricted session. Every failure is fatal. */
export async function resolveSelectedAgentConfigForSession(
  project: GitBackedProject,
  agentName: string,
  baseRef?: string | null,
  options: CompileReadOptions = {},
): Promise<string> {
  const ref = baseRef?.trim() || project.defaultBranch;
  const candidates = manifestCandidatePaths(project.manifestPath).map(
    (candidate) => candidate.path,
  );
  const found = await readManifestFromRepo(project, candidates, ref, {
    forceRefresh: options.forceRefresh,
  });
  if (!found) {
    throw new CompileAgentConfigError(
      `Project ${project.projectId} has no manifest for selected-agent compilation.`,
      agentName,
    );
  }

  const format = manifestFormatForPath(found.path);
  const raw = parseManifestText(found.content, format);
  options.onManifest?.(raw as Record<string, unknown>);
  if (manifestSchemaVersion(raw) === 3) {
    const validation = validateManifest(raw, format);
    if (!validation.valid) throw new CompileAgentConfigError(validation.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  if (![2, 3].includes(manifestSchemaVersion(raw))) {
    throw new CompileAgentConfigError(
      `Project ${project.projectId} must use kortix_version 2 or 3 for selected-agent compilation.`,
      agentName,
    );
  }

  const agentMdFiles: Record<string, string> = {};
  if (manifestSchemaVersion(raw) === 3) {
    const agents = raw.agents as Record<string, Record<string, unknown>>;
    const promptFile = agents?.[agentName]?.prompt_file;
    if (typeof promptFile === 'string') agentMdFiles[promptFile] = await readRepoFile(project, promptFile, ref);
  } else {
    const md = await readAgentMarkdownFile(project, raw, agentName, ref);
    if (md.content !== null) agentMdFiles[md.path] = md.content;
  }

  return JSON.stringify(compileSelectedAgentConfig(raw, agentName, 'opencode', agentMdFiles));
}
