/**
 * Coerce a value that the type system calls an array (but the API can return
 * as `undefined`/`null` or — for repo-less / capability-gated / config-build
 * failure states — occasionally a non-array object) into a real array.
 *
 * `?? []` alone is NOT enough here: it only covers `null`/`undefined`. When the
 * field comes back as a defined non-array (e.g. an empty object from a failed
 * config summary build), `value ?? []` returns that object and the subsequent
 * `.filter` / `.map` throws `TypeError: …filter is not a function` (the
 * `(intermediate value)(intermediate value)(intermediate value).filter is not a
 * function` Better Stack cluster — the prod build downlevels `??` to a ternary,
 * which is what produces the `(intermediate value)` wording). `Array.isArray`
 * guards both the undefined and the non-array cases.
 */
export function toArray<T>(value: readonly T[] | undefined | null): T[];
export function toArray<T>(value: unknown): T[];
export function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: raw };
  const afterTerminator = raw.slice(end + 4);
  return {
    frontmatter: raw.slice(3, end).replace(/^\n/, ''),
    body: afterTerminator.replace(/^\r?\n/, ''),
  };
}

/**
 * Manifest entities (v2/v3 agents, connectors, triggers) carry fragment paths
 * like `kortix.yaml#agents.claude` — a UI label pointing INTO the manifest,
 * not a readable file. Fetching one against the files/content endpoint 404s
 * (the exact "file not found on opening the Agents view" bug). Split it into
 * the real file and the dotted fragment; `null` for ordinary file paths.
 */
export function splitFragmentPath(path: string): { file: string; fragment: string } | null {
  const hash = path.indexOf('#');
  if (hash <= 0 || hash === path.length - 1) return null;
  return { file: path.slice(0, hash), fragment: path.slice(hash + 1) };
}

/**
 * Slice a named block out of YAML source by indentation — display-only (the
 * server owns real parsing; the web app deliberately has no YAML parser).
 * `fragment` is a dotted path of nested map keys (`agents.claude`). Returns
 * the block's lines from its `key:` header through its indented children
 * (interior blank lines kept, trailing ones trimmed), or `null` when any
 * segment is missing — callers fall back rather than guess.
 */
export function extractYamlFragment(content: string, fragment: string): string | null {
  const segments = fragment.split('.').filter(Boolean);
  if (segments.length === 0) return null;
  const lines = content.split('\n');
  let scopeStart = 0;
  let scopeEnd = lines.length;
  let headerIndex = -1;

  for (const segment of segments) {
    // A scope's direct children all sit at the indent of its first content
    // line — matching only that level keeps a same-named grandchild key from
    // hijacking the walk.
    let childIndent = -1;
    let headerIndent = 0;
    headerIndex = -1;
    for (let i = scopeStart; i < scopeEnd; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (childIndent === -1) childIndent = indent;
      if (indent !== childIndent) continue;
      if (trimmed === `${segment}:` || trimmed.startsWith(`${segment}: `)) {
        headerIndex = i;
        headerIndent = indent;
        break;
      }
    }
    if (headerIndex === -1) return null;
    // The block runs until the next content line at or above the header's
    // indent; blank lines inside pass through.
    let blockEnd = scopeEnd;
    for (let i = headerIndex + 1; i < scopeEnd; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= headerIndent) {
        blockEnd = i;
        break;
      }
    }
    scopeStart = headerIndex + 1;
    scopeEnd = blockEnd;
  }

  const block = lines.slice(headerIndex, scopeEnd);
  while (block.length > 0 && !block[block.length - 1]!.trim()) block.pop();
  return block.length > 0 ? block.join('\n') : null;
}

export function formatMode(mode: string): string {
  const m = mode.toLowerCase();
  if (m === 'primary') return 'Primary';
  if (m === 'subagent') return 'Subagent';
  return mode;
}
