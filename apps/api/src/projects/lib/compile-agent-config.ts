/**
 * The runtime compiler (spec docs/specs/2026-07-05-agent-first-config-unification.md
 * §2.3, redirected 2026-07-05 — "one home per concern"): turns a
 * `kortix_version: 2` manifest's `agents:` map (pure governance) plus each
 * agent's own native `.kortix/opencode/agents/<name>.md` (frontmatter +
 * body — the OpenCode behavior source of truth) into OpenCode-native config.
 *
 * The 2026-07-05 redirect killed the earlier "nested `opencode:` block in
 * kortix.yaml + illegal-frontmatter gate" design: OpenCode behavior
 * (mode/model/temperature/top_p/steps/variant/color/hidden/permission/prompt)
 * now lives ENTIRELY in the agent's own `.md` frontmatter + body — a stock
 * OpenCode agent `.md` is valid input as-is, frontmatter included. The
 * manifest's `agents.<name>` block carries governance ONLY (connectors/
 * secrets/skills/kortix_cli/workspace/enabled); the agent's NAME is the join
 * between the two (map key ↔ `.md` filename).
 *
 * `compileAgentConfig` is pure — no I/O, no DB. For each declared agent it
 * parses that agent's `.md` content (supplied by the caller, keyed by the
 * conventional path — see `agentMarkdownPath`), copies every recognized
 * OpenCode behavioral field straight through, and overlays governance on top:
 * `enabled: false` forces the runtime's `disable` on (governance always wins
 * on that one field); `skills` folds onto `permission.skill`. Every other
 * governance field (connectors/secrets/kortix_cli/workspace) has no runtime
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
import { z } from '@hono/zod-openapi';
import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  validateAgentMdFrontmatter,
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
import { type GitBackedProject, readManifestFromRepo, readRepoFile } from '../git';

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

/** The project's OpenCode config directory — the SAME top-level `[opencode]
 *  config_dir` v1 already reads (unrelated to per-agent behavior; this is
 *  just "where does `.kortix/opencode/...` live for this project"). Defaults
 *  to `.kortix/opencode`. */
function resolveConfigDir(manifest: Record<string, unknown>): string {
  const oc = manifest.opencode;
  if (oc && typeof oc === 'object' && !Array.isArray(oc)) {
    const dir = (oc as Record<string, unknown>).config_dir;
    if (typeof dir === 'string' && dir.trim()) {
      return dir.trim().replace(/\/+$/, '');
    }
  }
  return '.kortix/opencode';
}

/**
 * The conventional path to an agent's native `.md` file — the agent's NAME is
 * the join between the manifest's `agents:` map key and this file (spec
 * §2.2, 2026-07-05 redirect). No manifest field ever spells this path out.
 */
export function agentMarkdownPath(manifest: Record<string, unknown>, agentName: string): string {
  return `${resolveConfigDir(manifest)}/agents/${agentName}.md`;
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
  if (manifestSchemaVersion(manifest) !== 2) return null;

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

/**
 * Compile one agent: parse its `.md` (if supplied), copy every recognized
 * behavioral frontmatter field through unchanged, then overlay Kortix
 * governance — `enabled: false` forces `disable: true` (the one field where
 * governance always wins over whatever the `.md` itself says; there is no
 * other precedence to document since behavior lives ONLY in the `.md`), and
 * `skills` folds onto `permission.skill`. Pure governance fields (connectors/
 * secrets/kortix_cli/workspace) are never copied: no runtime representation.
 */
function compileAgentBlock(
  name: string,
  block: AgentBlockV2,
  mdPath: string,
  mdContent: string | undefined,
): OpencodeAgentConfig {
  const out: OpencodeAgentConfig = {};

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
export async function resolveCompiledAgentConfigForSession(
  project: GitBackedProject,
): Promise<string | null> {
  try {
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    const found = await readManifestFromRepo(project, candidates, project.defaultBranch);
    if (!found) return null;

    const format = manifestFormatForPath(found.path);
    const raw = parseManifestText(found.content, format);
    if (manifestSchemaVersion(raw) !== 2) return null;

    const v2 = raw as unknown as ManifestV2;
    const agents =
      v2.agents && typeof v2.agents === 'object' && !Array.isArray(v2.agents) ? v2.agents : {};

    const agentMdFiles: Record<string, string> = {};
    await Promise.all(
      Object.keys(agents).map(async (name) => {
        const path = agentMarkdownPath(raw, name);
        try {
          agentMdFiles[path] = await readRepoFile(project, path, project.defaultBranch);
        } catch (err) {
          console.warn(
            `[compile-agent-config] project ${project.projectId}: failed to read agent "${name}"'s behavior file "${path}": ${(err as Error).message}`,
          );
        }
      }),
    );

    const compiled = compileAgentConfig(raw, 'opencode', agentMdFiles);
    return compiled ? JSON.stringify(compiled) : null;
  } catch (err) {
    console.warn(
      `[compile-agent-config] project ${project.projectId}: compile failed, session boots without a compiled agent config: ${(err as Error).message}`,
    );
    return null;
  }
}
