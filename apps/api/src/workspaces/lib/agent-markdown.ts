/**
 * Read/write for an OpenCode agent's native `.md` file — YAML frontmatter +
 * body (the system prompt). This is now the ONE home for agent BEHAVIOR
 * (docs/specs/2026-07-05-agent-first-config-unification.md, decision
 * 2026-07-05: "OpenCode behavior lives in the native .md; Kortix governance
 * lives in kortix.yaml — one home per concern").
 *
 * Distinct from `@kortix/registry`'s `parseFrontmatter` (a dependency-free
 * flat-string reader used for SKILL.md metadata, shipped into the sandbox/CLI
 * bundle) — an agent's frontmatter can carry a full nested `permission` tree,
 * numbers, and booleans, so this uses the real YAML parser (already a
 * dependency of apps/api) instead.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export interface ParsedAgentMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a `.md` file's raw text into its YAML frontmatter (parsed to an
 * object) + prompt body. A file with no leading `---` fence — or one whose
 * fenced block isn't a YAML mapping — is treated as body-only (an empty
 * frontmatter object): a stock OpenCode agent `.md` with no fence at all is
 * valid input, never an error.
 */
export function parseAgentMarkdown(content: string): ParsedAgentMarkdown {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const [, frontmatterText, rest] = match;
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(frontmatterText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed frontmatter block is not this reader's concern to reject —
    // callers that care (the compiler) validate the parsed shape themselves;
    // this just degrades to "no recognized frontmatter" rather than throwing.
    frontmatter = {};
  }
  return { frontmatter, body: rest.replace(/^\s+/, '') };
}

/**
 * Inverse of `parseAgentMarkdown`. Omits the frontmatter fence entirely when
 * there are no fields to write, so a pure body-only file stays body-only
 * (no empty `---\n---\n` noise) — matches how a hand-authored OpenCode agent
 * `.md` with no frontmatter looks today.
 */
export function serializeAgentMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const trimmedBody = body.replace(/^\s+/, '');
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined) clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return trimmedBody;
  const frontmatterText = stringifyYaml(clean).trimEnd();
  return `---\n${frontmatterText}\n---\n\n${trimmedBody}`;
}
