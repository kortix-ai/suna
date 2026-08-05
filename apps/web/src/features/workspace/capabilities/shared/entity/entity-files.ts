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
 * Compares two paths' segments below the entity directory so siblings stay
 * grouped as a real tree, not a flat lexicographic list.
 *
 * Sorting the joined path as one string (the original approach here) put
 * `scripts/templates/comments.xml` ahead of `scripts/unpack.py`, because
 * `"t" < "u"` — visually wrong: `unpack.py` is a direct sibling of
 * `accept_changes.py`/`comment.py`/`pack.py`, but rendered outdented beneath
 * the entire `templates/` folder, reading as orphaned. Comparing segment by
 * segment fixes it: at the first differing position, a segment that is the
 * END of its own path (a leaf/file) sorts before one that continues further
 * (an intermediate directory) — so every file in a directory lists before
 * that directory's own subdirectories, regardless of alphabetical value.
 * Otherwise (both leaves, or both intermediate directories at this position)
 * `localeCompare` that segment.
 */
function compareSegments(a: readonly string[], b: readonly string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) continue;
    const aIsLeaf = i === a.length - 1;
    const bIsLeaf = i === b.length - 1;
    if (aIsLeaf !== bIsLeaf) return aIsLeaf ? -1 : 1;
    return a[i].localeCompare(b[i]);
  }
  return a.length - b.length;
}

/**
 * The entity's own files, from a repo listing already scoped to its directory.
 * SKILL.md sorts first because it is the entry point every reader wants; the
 * rest sort by path segments (`compareSegments`) so a directory's own files
 * stay grouped above its subdirectories — see that function's doc comment for
 * the exact bug this fixes.
 */
export function buildFileTree(paths: readonly string[], dir: string): FileNode[] {
  const prefix = dir ? `${dir}/` : '';
  return paths
    .filter((p) => (dir ? p.startsWith(prefix) : !p.includes('/')))
    .map((p) => {
      const rel = p.slice(prefix.length);
      const segments = rel.split('/');
      return { path: p, name: segments[segments.length - 1] ?? rel, depth: segments.length - 1, segments };
    })
    .sort((a, b) => {
      const aEntry = a.name === 'SKILL.md' && a.depth === 0;
      const bEntry = b.name === 'SKILL.md' && b.depth === 0;
      if (aEntry !== bEntry) return aEntry ? -1 : 1;
      return compareSegments(a.segments, b.segments);
    })
    .map(({ path, name, depth }) => ({ path, name, depth }));
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
