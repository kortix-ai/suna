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
export interface ProviderSentenceCopy {
  hosted: (provider: string) => string;
  stored: (provider: string) => string;
}

const DEFAULT_PROVIDER_SENTENCE_COPY: ProviderSentenceCopy = {
  hosted: (provider) => `Hosted on ${provider}.`,
  stored: (provider) => `Stored in ${provider}.`,
};

export function providerSentence(
  provider: string | null | undefined,
  copy: ProviderSentenceCopy = DEFAULT_PROVIDER_SENTENCE_COPY,
): string {
  const label = providerLabel(provider);
  if (provider === 'code-storage' || provider === 'code_storage') return copy.stored(label);
  return copy.hosted(label);
}

export function repositoryWebUrl(
  provider: string | null | undefined,
  repoUrl: string,
): string | null {
  if (provider !== 'github' && provider !== 'gitlab') return null;
  return repoUrl.replace(/\.git$/i, '');
}

export type ConnectionTone = 'connected' | 'attention' | 'unknown';

export interface ConnectionStatusCopy {
  connected: string;
  attention: string;
  connecting: string;
  disconnected: string;
}

const DEFAULT_CONNECTION_STATUS_COPY: ConnectionStatusCopy = {
  connected: 'Connected',
  attention: 'Needs attention',
  connecting: 'Connecting…',
  disconnected: 'Not connected',
};

/**
 * A backend connection status turned into something a person can act on.
 *
 * `tone` drives the status dot; `label` is the text beside it. An unrecognized
 * status resolves to "Not connected" rather than being echoed verbatim — a
 * status string this UI has never been taught is, from the user's side,
 * exactly as useful as no connection at all, and printing the enum would just
 * ask them to interpret it.
 */
export function connectionStatusLabel(
  status: string | null | undefined,
  copy: ConnectionStatusCopy = DEFAULT_CONNECTION_STATUS_COPY,
): {
  tone: ConnectionTone;
  label: string;
} {
  if (status === 'connected') return { tone: 'connected', label: copy.connected };
  if (status === 'error' || status === 'failed')
    return { tone: 'attention', label: copy.attention };
  if (status === 'pending' || status === 'connecting') {
    return { tone: 'unknown', label: copy.connecting };
  }
  return { tone: 'unknown', label: copy.disconnected };
}

/** Rows the default-branch picker renders at once. */
export const BRANCH_PICKER_LIMIT = 50;

/**
 * The rows the default-branch picker shows for one search string.
 *
 * A long-lived project's remote holds one branch per session: thousands of
 * refs. Rendering each as a menu row froze the tab, then crashed it. The
 * picker now renders at most `limit` rows and says how many it held back.
 *
 * The current branch always comes first when it matches, so the selected
 * value is visible without a search. Matching is a case-insensitive
 * substring; the order is otherwise the server's.
 */
export function filterBranchNames(
  names: readonly string[],
  current: string,
  query: string,
  limit: number = BRANCH_PICKER_LIMIT,
): { visible: string[]; hidden: number } {
  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const ordered = [current, ...names.filter((name) => name !== current)].filter(
    (name) => name && matches(name),
  );
  const unique = [...new Set(ordered)];
  return { visible: unique.slice(0, limit), hidden: Math.max(0, unique.length - limit) };
}
