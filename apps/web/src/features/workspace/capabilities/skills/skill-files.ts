import { configEntitySourcePath } from '@/features/workspace/customize/sections/component/config-entity-source-path';

export interface FileNode {
  name: string;
  path: string;
  /** Segments below the entity directory. 0 = sits directly in it. */
  depth: number;
}

/**
 * The directory a skill/command's own files live under, derived from the
 * entity's own `path` — never assume a fixed prefix. Real project data uses
 * `.kortix/opencode/skills/<name>/SKILL.md`; some fixtures/tests use
 * `.opencode/skill/<name>/SKILL.md`. Both work because this only looks at
 * the last `/`, after stripping a manifest anchor (`kortix.yaml#agents.x`)
 * via `configEntitySourcePath`.
 */
export function entityDirectory(path: string): string {
  const source = configEntitySourcePath(path);
  const cut = source.lastIndexOf('/');
  return cut === -1 ? '' : source.slice(0, cut);
}

/**
 * The entity's own files, from a repo listing already scoped to its directory.
 * SKILL.md sorts first because it is the entry point every reader wants; the
 * rest sort by path so `references/`/`scripts/` stays grouped and stable
 * between renders — including a nested `scripts/templates/` sitting under
 * `scripts/`, since path order groups every descendant under its parent.
 */
export function buildFileTree(paths: readonly string[], dir: string): FileNode[] {
  const prefix = dir ? `${dir}/` : '';
  return paths
    .filter((p) => (dir ? p.startsWith(prefix) : !p.includes('/')))
    .map((p) => {
      const rel = p.slice(prefix.length);
      return {
        path: p,
        name: rel.split('/').pop() ?? rel,
        depth: rel.split('/').length - 1,
      };
    })
    .sort((a, b) => {
      const aEntry = a.name === 'SKILL.md' && a.depth === 0;
      const bEntry = b.name === 'SKILL.md' && b.depth === 0;
      if (aEntry !== bEntry) return aEntry ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
}

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Whether a file renders through `UnifiedMarkdown` rather than a code block. */
export function isMarkdownPath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === 'md' || ext === 'markdown';
}

/**
 * Extension -> the language Shiki should highlight a non-markdown file with.
 * Mirrors `features/session/action-panel/easy/file-viewer.tsx`'s
 * `LANGUAGE_BY_EXT` (the established convention for feeding `CodeBlockCode` a
 * raw file's language), extended with a direct `xml` entry — that file only
 * aliases `svg` to `xml` and has no bare `xml` key, but skill/command
 * directories carry real `.xml` templates (e.g. the `docx` skill's
 * `scripts/templates/*.xml`) that need the same highlighting.
 *
 * An unknown or missing extension falls back to `'text'` — plain, unstyled
 * text, never a crash and never a guessed language.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
};

export function languageForPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? 'text';
}
