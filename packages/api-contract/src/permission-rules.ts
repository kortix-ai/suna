/**
 * The one permission precedence Kortix guarantees on every harness: the most
 * specific matching rule wins, whatever order the author wrote the keys in.
 * More specific = a longer pattern; two patterns of one length compare by code
 * unit, and the later one wins. The same order decides between permission
 * keys, so a tool's own key (`bash`) outranks the catch-all `*`.
 *
 * pi resolves rules with {@link comparePatterns} (harness/pi/interactions.ts).
 * OpenCode (1.18.23, permission/index.ts `fromConfig` + `evaluate`) flattens a
 * block in key order and applies the LAST matching rule, so
 * `bash: { 'git push *': 'ask', '*': 'allow' }` allowed `git push` there.
 * {@link orderPermissionRules} writes a block least specific first; OpenCode's
 * last match is then the most specific match.
 */

/** Least specific first: shorter, then code-unit order. */
export function comparePatterns(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

const sortKeys = (map: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(map).sort(([a], [b]) => comparePatterns(a, b)));

/**
 * One OpenCode `permission` block (a bare action, or `{ key: action | { pattern: action } }`)
 * with every key level ordered least specific first. Any other value is returned unchanged.
 *
 * ponytail: an integer-like key ("42") always iterates first in a JS object, so OpenCode
 * reads it as least specific. No permission name or real pattern is one today.
 */
export function orderPermissionRules<T>(permission: T): T {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return permission;
  const out = sortKeys(permission as Record<string, unknown>);
  for (const [key, rule] of Object.entries(out)) {
    if (rule && typeof rule === 'object' && !Array.isArray(rule)) out[key] = sortKeys(rule as Record<string, unknown>);
  }
  return out as T;
}
