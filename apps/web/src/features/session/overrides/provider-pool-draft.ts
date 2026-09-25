export type ProviderPoolDrafts = Record<string, string[] | null>;
type SavedPool = { provider_id: string; secret_ids: string[] };

/** An empty pool is never saved: the gateway fails every turn on one. Empty means default. */
export function normalizePoolSelection(selection: string[] | null): string[] | null {
  return selection && selection.length > 0 ? selection : null;
}

export function updateProviderPoolDraft(
  drafts: ProviderPoolDrafts,
  providerId: string,
  rawSelection: string[] | null,
  saved: SavedPool[],
): ProviderPoolDrafts {
  const selection = normalizePoolSelection(rawSelection);
  const next = { ...drafts };
  const previous = saved.find((pool) => pool.provider_id === providerId)?.secret_ids ?? null;
  if (JSON.stringify(previous) === JSON.stringify(selection)) delete next[providerId];
  else next[providerId] = selection;
  return next;
}

export function effectiveProviderPools(saved: SavedPool[], drafts: ProviderPoolDrafts): Record<string, string[]> {
  const selection = Object.fromEntries(saved.map((pool) => [pool.provider_id, pool.secret_ids]));
  for (const [provider, ids] of Object.entries(drafts)) {
    if (ids === null) delete selection[provider];
    else selection[provider] = ids;
  }
  return selection;
}

type SessionKey = { access_mode?: 'project' | 'members'; granted_user_ids?: string[] };

/**
 * The person whose own keys a session can use: its creator, in a private
 * session. None in a session shared with the project. `undefined` while the
 * session is unknown, which filters nothing.
 */
export function sessionPersonalUser(
  session: { visibility?: string | null; created_by?: string | null } | null | undefined,
): string | null | undefined {
  if (!session?.visibility) return undefined;
  return session.visibility === 'private' ? (session.created_by ?? null) : null;
}

/**
 * The keys a session can use when it runs. The gateway serves a session's
 * selection with the session's personal user (spec 2026-09-22 §2.3): keys
 * shared with the whole project always, a key granted to one member only in
 * that member's private session. Any other key would be refused on save.
 */
export function keysForSession<T extends SessionKey>(keys: T[], personalUser: string | null | undefined): T[] {
  if (personalUser === undefined) return keys;
  return keys.filter((key) =>
    key.access_mode === 'project' || (personalUser !== null && (key.granted_user_ids ?? []).includes(personalUser)));
}
