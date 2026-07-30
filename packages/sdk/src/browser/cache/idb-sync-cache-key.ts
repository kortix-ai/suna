export function buildSessionCacheKey(
  userScope: string,
  openCodeSessionId: string,
  kortixSessionScope?: string,
): string {
  if (!kortixSessionScope) {
    return `${userScope}:session:${openCodeSessionId}`;
  }
  return `${userScope}:kortix-session:${encodeURIComponent(kortixSessionScope)}`;
}
