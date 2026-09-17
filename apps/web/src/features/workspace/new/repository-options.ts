/**
 * The "Repository" choice on `/new`, as data.
 *
 * It used to be three abstract sources — `Kortix managed`, `Create in GitHub`,
 * `Import from GitHub` — plus a SECOND select for the GitHub account, which
 * only appeared after one of the GitHub sources was picked. A user with a
 * GitHub connection therefore had to pick "Create in GitHub", wait for a
 * second control to appear, and pick their organization out of it, while the
 * default offered was the one option that ignores the connection they had
 * already made.
 *
 * One list now. Each connected GitHub owner contributes its two actions —
 * create in it, import from it — in the order the API returns the
 * connections (oldest first, deterministic). `Kortix managed` is one option at
 * the END, and never reads as a GitHub connection.
 *
 * The first entry is the default, so an account with a connection defaults to
 * that connection and an account without one defaults to `Kortix managed`.
 */

import type { RepositorySource } from './new-workspace-form';

export type RepositoryChoiceKind = Extract<
  RepositorySource,
  'managed' | 'github-create' | 'github-import'
>;

export interface RepositoryChoice {
  /** The `<Select>` value. Stable, and parseable back into the pair below. */
  value: string;
  kind: RepositoryChoiceKind;
  /** The GitHub App installation this choice acts through. Null for `managed`. */
  installationId: string | null;
  /** The GitHub owner login, for the row's label. Null for `managed`. */
  ownerLogin: string | null;
}

export const MANAGED_CHOICE_VALUE = 'managed';

export interface RepositoryConnection {
  installation_id: string | null;
  owner_login: string | null;
}

/**
 * Every repository choice this account can make, in display order.
 *
 * `managedConfigured === false` omits the managed option entirely rather than
 * offering one that answers 503 on submit — `getManagedGitBackend()` is what
 * the caller reads for it.
 */
export function repositoryChoices(
  connections: readonly RepositoryConnection[],
  managedConfigured: boolean,
): RepositoryChoice[] {
  const choices: RepositoryChoice[] = [];
  for (const connection of connections) {
    const installationId = connection.installation_id;
    if (!installationId) continue;
    choices.push({
      value: `github-create:${installationId}`,
      kind: 'github-create',
      installationId,
      ownerLogin: connection.owner_login,
    });
    choices.push({
      value: `github-import:${installationId}`,
      kind: 'github-import',
      installationId,
      ownerLogin: connection.owner_login,
    });
  }
  if (managedConfigured) {
    choices.push({
      value: MANAGED_CHOICE_VALUE,
      kind: 'managed',
      installationId: null,
      ownerLogin: null,
    });
  }
  return choices;
}

/** The choice a `(source, installationId)` pair names, or null when the pair
 *  names nothing in the current list (a connection was disconnected, say). */
export function selectedChoice(
  choices: readonly RepositoryChoice[],
  source: RepositorySource,
  installationId: string | null,
): RepositoryChoice | null {
  const value = source === 'managed' ? MANAGED_CHOICE_VALUE : `${source}:${installationId ?? ''}`;
  return choices.find((choice) => choice.value === value) ?? null;
}

/** The choice a `<Select>` value names. Null for a value from a stale list. */
export function parseRepositoryChoice(
  choices: readonly RepositoryChoice[],
  value: string,
): RepositoryChoice | null {
  return choices.find((choice) => choice.value === value) ?? null;
}

/**
 * What the form should start on: the account's first GitHub connection when it
 * has one, `Kortix managed` otherwise.
 *
 * Null when the account has neither — the page then shows the "connect GitHub"
 * note instead of a select with nothing in it.
 */
export function defaultRepositoryChoice(
  choices: readonly RepositoryChoice[],
): RepositoryChoice | null {
  return choices[0] ?? null;
}
