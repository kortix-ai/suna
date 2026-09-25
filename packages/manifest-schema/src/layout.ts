/**
 * The project repository layout: where a project keeps its agents, skills,
 * memory and harness-specific files. The API, CLI, registry and starter
 * templates read every path from here. The sandbox daemon imports no
 * `@kortix/*` package and keeps its own copy (`harness/layout.ts`).
 *
 * Harness-neutral content sits at the repository root. A file that exactly
 * one harness reads sits under `harnesses/<harness>/`.
 *
 *   kortix.yaml
 *   agents/<name>.md          agent frontmatter + prompt (`agents.<name>.file`)
 *   skills/<name>/SKILL.md    skills, any harness
 *   memory/                   project memory
 *   harnesses/opencode/       OpenCode only: opencode.jsonc, plugins/, tools/
 *
 * Projects created before 2026-09 keep everything under `.kortix/opencode`
 * and `.kortix/memory`. Every reader still accepts that layout.
 *
 * Dependency-free on purpose: `index.v2.ts` and `json-schema.ts` both import
 * it, and neither may import the other.
 */

export const AGENTS_DIR = 'agents';
export const SKILLS_DIR = 'skills';
export const MEMORY_DIR = 'memory';
export const HARNESSES_DIR = 'harnesses';
/** Default OpenCode config dir (`opencode.config_dir`). */
export const OPENCODE_CONFIG_DIR = `${HARNESSES_DIR}/opencode`;
/** OpenCode config dir of the pre-2026-09 layout; it also held agents/ and skills/. */
export const LEGACY_OPENCODE_CONFIG_DIR = '.kortix/opencode';
export const LEGACY_MEMORY_DIR = '.kortix/memory';

/** The conventional `.md` of a new agent. Writers also record it as `agents.<name>.file`. */
export function defaultAgentFile(agentName: string): string {
  return `${AGENTS_DIR}/${agentName}.md`;
}

/**
 * A literal repo-relative path, or null. Rejects a leading `/` or `-`, empty,
 * `.` and `..` segments, and any character outside `[A-Za-z0-9_ .-]`. These
 * values become git revision paths and pathspecs, and pathspec magic such as
 * `:(top)*` must never reach git. A trailing `/` is dropped.
 */
export function safeRepoPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('-')) return null;
  const safe = trimmed
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && /^[\w .-]+$/.test(segment));
  return safe ? trimmed : null;
}

/** `agents.<name>.file`: a safe repo path whose last segment is `<something>.md`. */
export function safeAgentFile(value: unknown): string | null {
  const path = safeRepoPath(value);
  if (!path) return null;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.length > '.md'.length && base.endsWith('.md') ? path : null;
}

/** JSON Schema twin of `safeAgentFile` (validated by the conformance suite). */
export const AGENT_FILE_PATTERN = String.raw`^(?!-)(?!(?:.*/)?\.\.?(?:/|$))(?:[\w .-]+/)*[\w .-]+\.md$`;

function table(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The manifest's own `opencode.config_dir`, or null when it sets none (or an unsafe one). */
export function manifestOpencodeConfigDir(manifest: unknown): string | null {
  return safeRepoPath(table(table(manifest)?.opencode)?.config_dir);
}

/**
 * OpenCode config dirs to try, in order. The first one that ships an
 * `opencode.json[c]` is the project's OpenCode config dir.
 */
export function opencodeConfigDirCandidates(manifest: unknown): string[] {
  const explicit = manifestOpencodeConfigDir(manifest);
  return explicit ? [explicit] : [OPENCODE_CONFIG_DIR, LEGACY_OPENCODE_CONFIG_DIR];
}

/** The dir that held agents/ and skills/ in the pre-2026-09 layout. */
export function legacyConfigDir(manifest: unknown): string {
  return manifestOpencodeConfigDir(manifest) ?? LEGACY_OPENCODE_CONFIG_DIR;
}

/**
 * Where an agent's `.md` may be, most specific first. An explicit
 * `agents.<name>.file` is the only candidate (an unsafe one yields none).
 * Otherwise `agents/<name>.md`, then the legacy `<opencode dir>/agents/<name>.md`.
 */
export function agentFileCandidates(manifest: unknown, agentName: string): string[] {
  const block = table(table(table(manifest)?.agents)?.[agentName]);
  if (block && block.file !== undefined) {
    const file = safeAgentFile(block.file);
    return file ? [file] : [];
  }
  return [defaultAgentFile(agentName), `${legacyConfigDir(manifest)}/agents/${agentName}.md`];
}

/** Skill roots, most specific first. A skill name found in two roots resolves to the first. */
export function skillDirs(manifest: unknown): string[] {
  return [SKILLS_DIR, `${legacyConfigDir(manifest)}/skills`];
}
