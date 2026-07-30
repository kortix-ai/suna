/**
 * Tracks which sandbox currently owns each bare OpenCode session id in the
 * compatibility sync store. OpenCode ids are local to a sandbox. A restored
 * snapshot can therefore expose the same id from two different sandboxes.
 */

const owners = new Map<string, string>();

export function resolveSessionCacheOwnerScope(
  runtimeScope: string,
  kortixSessionScope?: string,
): string | null {
  if (kortixSessionScope) return `kortix:${kortixSessionScope}`;
  if (!runtimeScope || runtimeScope === 'none') return null;
  return `runtime:${runtimeScope}`;
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
  owners.set(sessionId, ownerScope);
  return { changed: true, previousOwnerScope };
}

export function resetSessionCacheOwnership(): void {
  owners.clear();
}
