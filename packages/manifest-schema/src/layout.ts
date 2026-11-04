/**
 * The project repository layout. The API, CLI, registry and starter templates
 * read every path from here.
 *
 *   kortix.yaml
 *   agents/<name>.md          an agent's prompt (`agents.<name>.prompt_file`)
 *   skills/<name>/SKILL.md    skills (`skills.<name>.path`)
 *   memory/                   project memory
 *
 * Dependency-free on purpose: `index.v2.ts` and `json-schema.ts` both import
 * it, and neither may import the other.
 */

export const AGENTS_DIR = 'agents';
export const SKILLS_DIR = 'skills';
export const MEMORY_DIR = 'memory';
/** The conventional prompt file of a new agent (`agents.<name>.prompt_file`). */
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
  // An index scan, not /\/+$/: that regex is quadratic on a long run of slashes.
  let end = value.trimEnd().length;
  while (end > 0 && value[end - 1] === '/') end--;
  const trimmed = value.slice(0, end).trim();
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

/** A project tool module (top-level `tools`): a safe repo path to a `.ts`/`.js` (`.mts`, `.mjs`, …) file, or null. */
export function safeToolFile(value: unknown): string | null {
  const path = safeRepoPath(value);
  return path && /[^/]\.[cm]?[jt]s$/.test(path) ? path : null;
}

/** JSON Schema twin of `safeToolFile`. */
export const TOOL_FILE_PATTERN = String.raw`^(?!-)(?!(?:.*/)?\.\.?(?:/|$))(?:[\w .-]+/)*[\w .-]+\.[cm]?[jt]s$`;
