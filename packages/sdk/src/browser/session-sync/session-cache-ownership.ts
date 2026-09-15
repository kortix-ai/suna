/**
 * Tracks which sandbox currently owns each bare OpenCode session id in the
 * compatibility sync store. OpenCode ids are local to a sandbox. A restored
 * snapshot can therefore expose the same id from two different sandboxes.
 *
 * Two kinds of owner scope exist, and the difference matters:
 *
 *  - `kortix:<projectId>/<sessionId>` — AUTHORITATIVE. The consumer was told
 *    which Kortix session it is reading, so it survives a sandbox replacement
 *    for that session (the transcript is not wiped when the box is re-created).
 *  - `runtime:<sandboxId>` — FALLBACK, for a standalone consumer that was given
 *    nothing but a bare OpenCode id.
 *
 * The two kinds must never be read as a disagreement. They describe the SAME
 * session from two consumers that simply know different amounts about it, and
 * both live in the one active runtime. Treating that as a collision made the
 * two hooks evict each other: whichever claimed last owned the id, and the
 * other one read an empty transcript for the rest of the page's life.
 */

const owners = new Map<string, string>();

const AUTHORITATIVE_PREFIX = 'kortix:';

function isAuthoritative(ownerScope: string): boolean {
  return ownerScope.startsWith(AUTHORITATIVE_PREFIX);
}

export function resolveSessionCacheOwnerScope(
  runtimeScope: string,
  kortixSessionScope?: string,
): string | null {
  if (kortixSessionScope) return `${AUTHORITATIVE_PREFIX}${kortixSessionScope}`;
  if (!runtimeScope || runtimeScope === 'none') return null;
  return `runtime:${runtimeScope}`;
}

/**
 * Do two owner scopes name genuinely DIFFERENT owners of the same OpenCode id
 * — i.e. is the cached data for this id foreign to the asking consumer?
 *
 * Only two scopes of the same KIND can disagree. That is the real case this
 * module exists to catch: another sandbox (or another Kortix session) reusing
 * an OpenCode id. A fallback scope never contradicts an authoritative one.
 */
export function sessionCacheOwnerScopesConflict(a: string | null, b: string | null): boolean {
  if (!a || !b || a === b) return false;
  return isAuthoritative(a) === isAuthoritative(b);
}

export function getSessionCacheOwnership(sessionId: string): string | null {
  return owners.get(sessionId) ?? null;
}

export function claimSessionCacheOwnership(
  sessionId: string,
  ownerScope: string,
): { changed: boolean; previousOwnerScope: string | null } {
  const previousOwnerScope = getSessionCacheOwnership(sessionId);
  if (previousOwnerScope === ownerScope) {
    return { changed: false, previousOwnerScope };
  }
  // A fallback claim never displaces an authoritative one — the consumer that
  // knows which Kortix session this is stays the owner of record.
  if (
    previousOwnerScope !== null &&
    !isAuthoritative(ownerScope) &&
    isAuthoritative(previousOwnerScope)
  ) {
    return { changed: false, previousOwnerScope };
  }
  owners.set(sessionId, ownerScope);
  return { changed: true, previousOwnerScope };
}

export function resetSessionCacheOwnership(): void {
  owners.clear();
}
