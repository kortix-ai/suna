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




export function formatMode(mode: string): string {
  const m = mode.toLowerCase();
  if (m === 'primary') return 'Primary';
  if (m === 'subagent') return 'Subagent';
  return mode;
}

