/**
 * Per-harness native config-directory validation: presence + shape + lint,
 * NEVER translation or behavioral interpretation. Kortix does not understand
 * what a harness's config *means* — it only checks that what's there is
 * well-formed enough not to fail at session boot. See
 * docs/superpowers/plans/2026-07-15-cortex-cycle-plan.md §6 P2: "the
 * platform validates native harness config; it never translates one
 * harness's behavior format into another."
 *
 * Pure function: the caller supplies the repo tree slice under `configDir`
 * as `FileTreeEntry[]` — no fs/git reads happen here, so this is trivially
 * unit-testable (inline fixtures, no disk/repo) and safe to run from any
 * context (API route, CLI, CI check) without wiring I/O through it.
 */
import { parse as parseToml } from 'smol-toml';
import { HARNESSES, type HarnessId } from '@kortix/shared';
import { frontmatterParseError } from './agent-markdown';

export type HarnessConfigIssue = {
  harness: HarnessId;
  /** Experimental harnesses (per `HARNESSES[id].stability`) emit at most 'warning' — they must never hard-block a project. */
  severity: 'error' | 'warning';
  /** Repo-relative file/dir the issue is about. */
  path: string;
  message: string;
};

/** One entry in the repo tree slice under a harness's `configDir`. `content` null/omitted means a presence-only entry (e.g. a directory, or a file whose contents weren't fetched). */
export type FileTreeEntry = { path: string; content?: string | null };

function severityFor(harness: HarnessId): 'error' | 'warning' {
  return HARNESSES[harness].stability === 'stable' ? 'error' : 'warning';
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** `file.path` with the `configDir` prefix stripped, for matching patterns (like `agent/*.md`) relative to the config root. */
function relativeToConfigDir(path: string, configDir: string): string {
  const dir = configDir.replace(/\/+$/, '');
  if (path === dir) return '';
  if (path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
  return path;
}

const AGENT_MD_RE = /^agents?\/[^/]+\.md$/;

function isAgentMdPath(relPath: string): boolean {
  return AGENT_MD_RE.test(relPath);
}

function checkAgentFrontmatter(
  harness: HarnessId,
  file: FileTreeEntry,
  issues: HarnessConfigIssue[],
): void {
  if (file.content == null) return;
  const err = frontmatterParseError(file.content);
  if (err) {
    issues.push({
      harness,
      severity: severityFor(harness),
      path: file.path,
      message: `agent frontmatter failed to parse: ${err}`,
    });
  }
}

function checkJsonFile(
  harness: HarnessId,
  file: FileTreeEntry,
  issues: HarnessConfigIssue[],
  requireObject: boolean,
): void {
  if (file.content == null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch (err) {
    issues.push({
      harness,
      severity: severityFor(harness),
      path: file.path,
      message: `${basename(file.path)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (requireObject && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    issues.push({
      harness,
      severity: severityFor(harness),
      path: file.path,
      message: `${basename(file.path)} must be a JSON object`,
    });
  }
}

function checkTomlFile(harness: HarnessId, file: FileTreeEntry, issues: HarnessConfigIssue[]): void {
  if (file.content == null) return;
  try {
    parseToml(file.content);
  } catch (err) {
    issues.push({
      harness,
      severity: severityFor(harness),
      path: file.path,
      message: `${basename(file.path)} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Validate one harness's native config directory. Presence + shape + lint
 * only — never translates or interprets what the config *does*.
 *
 * - All harnesses: an empty/missing `configDir` is one issue.
 * - `opencode`: `agent/*.md` / `agents/*.md` frontmatter must parse; a JSON
 *   config file (`opencode.json`) must be valid JSON.
 * - `claude`: `settings.json` must be a valid JSON object; `agents/*.md`
 *   frontmatter must parse (YAML-fence-parses check only — no schema, since
 *   Claude's agent frontmatter shape differs from OpenCode's).
 * - `codex`: `config.toml` must be valid TOML.
 * - `pi`: presence-only this cycle (no documented shape to lint against).
 */
export function validateHarnessConfig(
  harness: HarnessId,
  configDir: string,
  files: FileTreeEntry[],
): HarnessConfigIssue[] {
  const issues: HarnessConfigIssue[] = [];

  if (files.length === 0) {
    issues.push({
      harness,
      severity: severityFor(harness),
      path: configDir,
      message: 'config directory is empty or missing',
    });
    return issues;
  }

  if (harness === 'opencode') {
    for (const file of files) {
      const rel = relativeToConfigDir(file.path, configDir);
      if (isAgentMdPath(rel)) checkAgentFrontmatter(harness, file, issues);
      if (basename(file.path) === 'opencode.json') checkJsonFile(harness, file, issues, false);
    }
  } else if (harness === 'claude') {
    for (const file of files) {
      const rel = relativeToConfigDir(file.path, configDir);
      if (basename(file.path) === 'settings.json') checkJsonFile(harness, file, issues, true);
      if (isAgentMdPath(rel)) checkAgentFrontmatter(harness, file, issues);
    }
  } else if (harness === 'codex') {
    for (const file of files) {
      if (basename(file.path) === 'config.toml') checkTomlFile(harness, file, issues);
    }
  }
  // pi: presence-only this cycle — the empty-dir check above is the only rule.

  return issues;
}
