/** Pure: no database or config imports, so the rate limiter can use it. */

import { isUuid } from './validate';

const PUBLIC_SHARE_TOKEN_RE = /^kps_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

/**
 * The share id a public reference names, or null. A reference is either the
 * raw `share_id` (uuid) or the `kps_` public token, which is the same id with
 * the dashes removed. Both are equally sensitive: either one discloses the
 * other. Accepting the token lets a viewer keyed by `/share/session/<token>`
 * read the public routes without re-deriving the id.
 */
export function shareIdFromPublicRef(ref: string): string | null {
  if (isUuid(ref)) return ref;
  const match = PUBLIC_SHARE_TOKEN_RE.exec(ref);
  return match ? match.slice(1).join('-') : null;
}
