/**
 * Small HTTP caching helpers for read endpoints whose body can be cached
 * briefly with revalidation (short `max-age` + ETag, never
 * `stale-while-revalidate` — see the maintenance route in `index.ts` for why
 * that matters for an emergency kill switch).
 *
 * `computeEtag` hashes the exact JSON payload being served, so the ETag is
 * content-addressed: it's stable across calls that return the same body and
 * changes the instant the body does, independent of whether the caller also
 * bumped a separate timestamp field.
 */
import { createHash } from 'node:crypto';

export function computeEtag(payload: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `"${hash}"`;
}

/**
 * Does the raw `If-None-Match` request header match `etag`? Handles the
 * multi-value (`"a", "b"`) and weak-validator (`W/"a"`) forms a real client
 * or intermediary cache may send, and the `*` wildcard.
 */
export function etagMatches(ifNoneMatch: string | undefined | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .includes(etag);
}
