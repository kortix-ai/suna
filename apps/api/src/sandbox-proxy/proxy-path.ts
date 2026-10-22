/**
 * One canonical spelling of a proxied request path.
 *
 * The API gates a request (turn ledger, agent-switch authz, dedupe, the
 * `/kortix/env` block) by matching the path text. The daemon and OpenCode are
 * Hono servers: `getPath` runs `decodeURI` on the path (hono 4.x
 * `dist/utils/url.js`), so `prompt%5Fasync` routes as `prompt_async`. A gate
 * that reads the raw text and a daemon that reads the decoded text disagree,
 * and the encoded spelling skips every gate.
 *
 * This function removes the disagreement. It decodes every percent-escape that
 * stands for an unreserved character (`A-Z a-z 0-9 - . _ ~`; RFC 3986 section
 * 6.2.2.2 calls the result equivalent), upper-cases the hex of the rest, and
 * collapses `//`. The gates and the upstream hop then see the same bytes the
 * daemon will route on. On a session-data port it also refuses what Hono would
 * read differently: a malformed escape, an encoded `/`, `\` or NUL, and a dot
 * segment that appears only after decoding.
 *
 * A LEAF: it imports nothing.
 */

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

const hasDotSegment = (p: string) => p.split('/').some((s) => s === '.' || s === '..');

/**
 * @returns the canonical path, or `null` when `strict` and the path is
 * ambiguous. A trailing `?query` or `#fragment` is kept as written.
 */
export function canonicalProxyPath(path: string, strict: boolean): string | null {
  const tail = path.search(/[?#]/);
  const pathname = tail === -1 ? path : path.slice(0, tail);
  const rest = tail === -1 ? '' : path.slice(tail);
  if (!pathname.includes('%') && !pathname.includes('//')) return path;

  let bad = false;
  const decoded = pathname.replace(/%(..?)?/g, (match, hex?: string) => {
    if (!hex || !/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bad = true;
      return match;
    }
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    if (UNRESERVED.test(char)) return char;
    if (char === '/' || char === '\\' || char === '\0') bad = true;
    return `%${hex.toUpperCase()}`;
  });
  if (strict && bad) return null;
  const collapsed = strict ? decoded.replace(/\/{2,}/g, '/') : decoded;
  // A literal dot segment is the URL parser's to resolve. One that appears only
  // after decoding came from `%2e`: refuse it.
  if (strict && hasDotSegment(collapsed) && !hasDotSegment(pathname)) return null;
  return collapsed + rest;
}
