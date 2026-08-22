/**
 * Pure copy + URL helpers for the Repositories pane (`git-view.tsx`).
 *
 * Everything the pane says about a Git connection is derived here rather than
 * inline in JSX, for one reason: the pane's whole job in this rewrite is to
 * stop leaking backend vocabulary at the user, and copy that lives in a pure
 * function can be pinned by a test. The old pane rendered
 * `connection?.status || 'Unknown'` — a raw API enum straight onto the screen,
 * under the label "Connection health" — so a new server status would have
 * silently shipped itself to users as-is. `connectionStatusLabel` makes the
 * unknown case a deliberate, tested string instead.
 */

export function providerLabel(provider: string | null | undefined): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'code-storage' || provider === 'code_storage') return 'Kortix Code Storage';
  if (provider === 'gitlab') return 'GitLab';
  return provider ? provider.replaceAll('_', ' ') : 'Git';
}

/**
 * The provider stated as a sentence, for the Repository row's description.
 *
 * This is why the pane has no separate "Provider" row: the fact fits inside a
 * row that already exists. Code Storage reads "Stored in" rather than "Hosted
 * on" because it is Kortix's own storage, not a third-party host the user has
 * an account with — the difference decides whether they go looking for a login
 * somewhere else.
 */
export function providerSentence(provider: string | null | undefined): string {
  const label = providerLabel(provider);
  if (provider === 'code-storage' || provider === 'code_storage') return `Stored in ${label}.`;
  return `Hosted on ${label}.`;
}

export function repositoryWebUrl(
  provider: string | null | undefined,
  repoUrl: string,
): string | null {
  if (provider !== 'github' && provider !== 'gitlab') return null;
  return repoUrl.replace(/\.git$/i, '');
}

export type ConnectionTone = 'connected' | 'attention' | 'unknown';

/**
 * A backend connection status turned into something a person can act on.
 *
 * `tone` drives the status dot; `label` is the text beside it. An unrecognized
 * status resolves to "Not connected" rather than being echoed verbatim — a
 * status string this UI has never been taught is, from the user's side,
 * exactly as useful as no connection at all, and printing the enum would just
 * ask them to interpret it.
 */
export function connectionStatusLabel(status: string | null | undefined): {
  tone: ConnectionTone;
  label: string;
} {
  if (status === 'connected') return { tone: 'connected', label: 'Connected' };
  if (status === 'error' || status === 'failed') return { tone: 'attention', label: 'Needs attention' };
  if (status === 'pending' || status === 'connecting') return { tone: 'unknown', label: 'Connecting…' };
  return { tone: 'unknown', label: 'Not connected' };
}
