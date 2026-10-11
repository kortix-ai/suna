/**
 * What the connector page shows while it resolves its connector from the list.
 *
 * Only a SETTLED list may declare the connector missing. Install invalidates
 * the list and navigates here at once, so the cached list does not hold the
 * new connector yet; and a failed request is not a deletion.
 */
export function connectorPageState(input: {
  found: boolean;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
}): 'ready' | 'loading' | 'error' | 'missing' {
  if (input.found) return 'ready';
  if (input.isPending || input.isFetching) return 'loading';
  if (input.isError) return 'error';
  return 'missing';
}

/**
 * What to do with the install hand-off, `?connect=<connection id>`.
 *
 * The id comes from the URL, so it is not trusted: credential entry opens only
 * for a connection that is one of THIS connector's accounts, and the owner is
 * read from that row. Otherwise a crafted link could put a secret typed for
 * this connector into another connector's connection. A project-owned account
 * opens only for someone who may manage the project's connections — the same
 * gate the account row applies to "Set credential". That row offers it only on
 * a direct provider, so a managed, computer, or channel connector discards the
 * id at once: its accounts have no static credential to enter.
 *
 * Install navigates here right after it creates the account, so the cached
 * list may not hold the row yet. An unknown id waits while the list is
 * fetching, and a settled list is refetched once before the id is discarded:
 * a cache younger than its stale time does not fetch on mount.
 */
export function connectHandoff(input: {
  connectId: string | null;
  /** This connector's accounts only. */
  accounts: readonly { connection_id: string; owner_type: string }[];
  /** Nothing is loading: not the account list, not the manage-right probe. */
  settled: boolean;
  /** The account list was refetched for this `connectId`. */
  refetched: boolean;
  canManageConnections: boolean;
  /** The connector takes a static credential: not managed, not a computer, not a channel. */
  direct: boolean;
}):
  | { action: 'wait' }
  | { action: 'none' }
  | { action: 'refetch' }
  | { action: 'open'; connectionId: string; owner: 'project' | 'me' }
  | { action: 'discard' } {
  if (!input.connectId) return { action: 'none' };
  if (!input.direct) return { action: 'discard' };
  const row = input.accounts.find((account) => account.connection_id === input.connectId);
  if (row) {
    const owner = row.owner_type === 'project' ? 'project' : 'me';
    if (owner === 'me' || input.canManageConnections) {
      return { action: 'open', connectionId: row.connection_id, owner };
    }
    // `canManageConnections` reads false until its probe answers.
    return { action: input.settled ? 'discard' : 'wait' };
  }
  if (!input.settled) return { action: 'wait' };
  return { action: input.refetched ? 'discard' : 'refetch' };
}
