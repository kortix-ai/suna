/**
 * The runtime compiler (spec docs/specs/2026-07-05-agent-first-config-unification.md
 * §2.3): turns a `kortix_version: 2` manifest's `agents:` map into OpenCode-native
 * config, so agent BEHAVIOR (prompt/mode/model/permission/…) stops depending on
 * hand-authored `.kortix/opencode/agents/*.md` frontmatter that Kortix used to
 * pass through blind.
 *
 * `compileAgentConfig` is pure — no I/O, no DB. It maps every `AgentBlockV2`
 * behavioral field 1:1 onto its OpenCode `AgentConfig` equivalent (full parity,
 * spec §2.2). The Kortix governance fields (`connectors`/`secrets`/`kortix_cli`/
 * `workspace`) are deliberately NEVER copied into the output — they're enforced
 * platform-side (IAM grants, secret scoping), not by the runtime, so they have
 * no OpenCode representation.
 *
 * `resolveCompiledAgentConfigForSession` is the I/O half: reads the project's
 * manifest + each declared agent's prompt file straight from git (bypassing
 * apps/api's v1-only `triggers.ts` manifest reader, which still caps at
 * `kortix_version` 1 — this compiler is the first apps/api consumer of a v2
 * manifest's `agents:` map, so it reads the raw text itself via
 * `@kortix/manifest-schema` rather than waiting on that cap to move). It never
 * throws: a v1 project (or any read/parse/compile failure) resolves to `null`,
 * which is the "v1 byte-for-byte unaffected" contract the session-env wiring
 * depends on.
 */
import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  type AgentBlockV2,
  type GrantSetV2,
  type ManifestV2,
  type OpencodeAgentConfigV2,
  type PermissionActionV2,
  type PermissionConfigObjectV2,
  type PermissionConfigV2,
  type PermissionRuleV2,
  type RuntimeV2,
} from '@kortix/manifest-schema';
import { parseFrontmatter } from '@kortix/registry';
import { type GitBackedProject, readManifestFromRepo, readRepoFile } from '../git';

/** OpenCode's per-agent `AgentConfig` — the compiled shape for one `agent.<name>` entry. */
export interface OpencodeAgentConfig {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  /** Either the resolved (frontmatter-stripped) prompt body, or — when the
   *  caller didn't supply the file's content — an OpenCode `{file:<path>}`
   *  reference as a best-effort fallback (see `compileAgentBlock`). */
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
   *  declared model, so a brand-new session (no agent picked yet) starts on
   *  the same model its default agent would resolve to. Omitted when the
   *  default agent declares no model (the platform/account default applies,
   *  same as today). */
  model?: string;
  /** No v2 manifest field maps to a top-level `small_model` today — passthrough
   *  is a no-op until one exists. Reserved so a future field has somewhere to land
   *  without another signature change. */
  small_model?: string;
  agent: Record<string, OpencodeAgentConfig>;
}

/** Raised when a v2 manifest can't be compiled — a genuine authoring error
 *  (illegal frontmatter, unsupported runtime), not a transient I/O failure. */
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

/** AgentBlockV2 keys the manifest owns — illegal in a v2 agent's prompt `.md`
 *  frontmatter (spec §2.2: "one source of truth"). Flat, OpenCode-native
 *  names regardless of whether the manifest itself nests them under
 *  `opencode:` — a hand-authored `.md`'s frontmatter is OpenCode's own file
 *  format, not manifest YAML, so it never has the Kortix/OpenCode split.
 *  Lowercased for comparison. */
const ILLEGAL_FRONTMATTER_KEYS = new Set([
  'description',
  'enabled',
  'mode',
  'model',
  'variant',
  'temperature',
  'top_p',
  'prompt',
  'disable',
  'hidden',
  'options',
  'color',
  'steps',
  'permission',
  'connectors',
  'secrets',
  'skills',
  'kortix_cli',
  'workspace',
  // Deprecated upstream fields the manifest schema already rejects — calling
  // them out here too gives a pointer even if they only ever show up in the
  // .md (never survived manifest validation).
  'tools',
  'maxsteps',
]);

/**
 * Compile a manifest's declared agents into an OpenCode-native config.
 *
 * `manifest` is the raw parsed object (TOML/YAML decode to the same shape —
 * see `@kortix/manifest-schema`'s format layer), not necessarily typed as
 * `ManifestV2` by the caller: this function itself is the version gate.
 *
 * Returns `null` for anything that isn't a `kortix_version: 2` manifest — the
 * compiler is a v1 NO-OP by design (spec §2.3: "v2-only feature"), so v1
 * projects keep depending on hand-authored `.md` frontmatter exactly as before.
 *
 * `promptFiles` maps an agent's declared `prompt:` path to that file's raw text
 * content (as read from the project's repo). When a path is present, its
 * frontmatter is validated (throws `CompileAgentConfigError` on an illegal key,
 * spec §2.2 "the compiler errors if a referenced .md still carries frontmatter
 * keys that belong in the manifest") and the body (frontmatter stripped) is
 * inlined as the resolved prompt string. When a path is ABSENT from the map
 * (caller didn't/couldn't preload it), the compiler falls back to an OpenCode
 * `{file:<path>}` reference and skips validation — callers that can read the
 * repo (the session-env wiring below) should always populate this map.
 */
export function compileAgentConfig(
  manifest: Record<string, unknown>,
  runtime: RuntimeV2 = 'opencode',
  promptFiles: Record<string, string> = {},
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
    agent[name] = compileAgentBlock(name, block, promptFiles);
  }

  const defaultAgentName = typeof v2.default_agent === 'string' ? v2.default_agent : undefined;
  const defaultModel =
    defaultAgentName && typeof rawAgents[defaultAgentName]?.model === 'string'
      ? rawAgents[defaultAgentName].model
      : undefined;

  return {
    ...(defaultModel ? { model: defaultModel } : {}),
    agent,
  };
}

/** Map one `AgentBlockV2` onto its OpenCode `AgentConfig` equivalent — full
 *  parity, 1:1 by design (spec §2.2). The Kortix layer (top-level
 *  description/model/enabled) and the OpenCode layer (nested under
 *  `opencode:`) are two different INPUT shapes that compile to the SAME flat
 *  OUTPUT shape the runtime has always understood — the compiler is exactly
 *  where that translation happens. Pure Kortix governance fields
 *  (connectors/secrets/kortix_cli/workspace) are never copied: they have no
 *  runtime representation. `skills` is the one governance field that DOES
 *  compile to something OpenCode understands — see `applySkillsGovernance`. */
function compileAgentBlock(
  name: string,
  block: AgentBlockV2,
  promptFiles: Record<string, string>,
): OpencodeAgentConfig {
  const out: OpencodeAgentConfig = {};
  if (block.description !== undefined) out.description = block.description;
  if (block.model !== undefined) out.model = block.model;
  // Kortix `enabled` (default true) inverts onto the runtime's `disable` —
  // only emit `disable` when the agent is actually turned off, matching the
  // prior byte-for-byte output for every agent that doesn't set it.
  if (block.enabled === false) out.disable = true;

  const oc: OpencodeAgentConfigV2 = block.opencode ?? {};
  if (oc.mode !== undefined) out.mode = oc.mode;
  if (oc.variant !== undefined) out.variant = oc.variant;
  if (oc.temperature !== undefined) out.temperature = oc.temperature;
  if (oc.top_p !== undefined) out.top_p = oc.top_p;
  if (oc.hidden !== undefined) out.hidden = oc.hidden;
  if (oc.options !== undefined) out.options = oc.options;
  if (oc.color !== undefined) out.color = oc.color;
  if (oc.steps !== undefined) out.steps = oc.steps;
  if (oc.permission !== undefined) out.permission = oc.permission;

  if (oc.prompt !== undefined) {
    out.prompt = compilePrompt(name, oc.prompt, promptFiles);
  }

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
 * whatever `permission` the agent block already compiled to.
 *
 * PRECEDENCE (documented, deliberate): when `skills` is set on the manifest
 * block, it OWNS the `skill` key outright — it overrides any hand-authored
 * `permission.skill` rule, the same "governance wins" posture the other
 * Kortix-enforced fields (connectors/secrets/kortix_cli) already have. An
 * author who omits `skills` entirely keeps full manual control over
 * `permission.skill` (this function is never called in that case — see
 * `compileAgentBlock`), so hand-rolled per-skill glob rules remain a
 * supported escape hatch for anyone not using the governance picker.
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

function compilePrompt(
  agentName: string,
  promptPath: string,
  promptFiles: Record<string, string>,
): string {
  const content = promptFiles[promptPath];
  if (content === undefined) {
    // Best-effort fallback for a caller that couldn't preload the file (e.g.
    // offline tooling). NOT validated — frontmatter-illegal only catches what
    // this function can actually read.
    return `{file:${promptPath}}`;
  }
  assertNoIllegalFrontmatter(agentName, promptPath, content);
  return stripFrontmatter(content);
}

function assertNoIllegalFrontmatter(agentName: string, promptPath: string, content: string): void {
  const frontmatter = parseFrontmatter(content);
  const illegal = Object.keys(frontmatter).filter((key) =>
    ILLEGAL_FRONTMATTER_KEYS.has(key.toLowerCase()),
  );
  if (illegal.length === 0) return;
  throw new CompileAgentConfigError(
    `Agent "${agentName}"'s prompt file "${promptPath}" still carries frontmatter key(s) ` +
      `${illegal.map((k) => `"${k}"`).join(', ')} that belong in the manifest under ` +
      `agents.${agentName} — kortix_version 2 requires body-only prompt files ` +
      `(one source of truth, spec §2.2). Move them into the manifest and remove ` +
      `the frontmatter block.`,
    agentName,
  );
}

/** Strip a leading `---\n…\n---` YAML frontmatter block, if present. Body-only
 *  content (no frontmatter) passes through unchanged. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const closing = content.indexOf('\n---', 3);
  if (closing === -1) return content;
  const afterClosingLine = content.indexOf('\n', closing + 1);
  const body = afterClosingLine === -1 ? '' : content.slice(afterClosingLine + 1);
  return body.replace(/^\s+/, '');
}

/**
 * Read a project's manifest straight from git + compile it (I/O half). Never
 * throws: any read/parse/compile failure resolves to `null` so a broken or
 * mid-migration manifest never blocks session provisioning — a manifest
 * authoring error (e.g. illegal frontmatter) should surface at `kortix
 * validate` / CR-merge time, not by failing a session boot months later.
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

    const promptFiles: Record<string, string> = {};
    await Promise.all(
      Object.values(agents).map(async (block) => {
        const promptPath = block?.opencode?.prompt;
        if (typeof promptPath !== 'string' || !promptPath.trim()) return;
        const path = promptPath.trim();
        if (path in promptFiles) return;
        try {
          promptFiles[path] = await readRepoFile(project, path, project.defaultBranch);
        } catch (err) {
          console.warn(
            `[compile-agent-config] project ${project.projectId}: failed to read prompt file "${path}": ${(err as Error).message}`,
          );
        }
      }),
    );

    const compiled = compileAgentConfig(raw, 'opencode', promptFiles);
    return compiled ? JSON.stringify(compiled) : null;
  } catch (err) {
    console.warn(
      `[compile-agent-config] project ${project.projectId}: compile failed, session boots without a compiled agent config: ${(err as Error).message}`,
    );
    return null;
  }
}
