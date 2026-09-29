/**
 * The "Git account" choice on `/new`, as data.
 *
 * A project's repository lives under exactly one git owner: a GitHub personal
 * account or organization the Kortix account has connected, or `Kortix
 * managed` — the instance's own backend. So the first question is WHOSE
 * account, and only then what to do there (create a repository, or import one
 * that exists). Two questions, two controls; the previous single flat list
 * ("Create a repository in X / Import a repository from X / …") multiplied
 * the owners by the actions and read as a repository menu, which it never was.
 *
 * Connections come first, in the order the API returns them (oldest first,
 * deterministic); `Kortix managed` is one option at the END and never reads as
 * a GitHub connection. The first entry is the default, so an account with a
 * connection defaults to that connection and an account without one defaults
 * to `Kortix managed`.
 *
 * The form state does not change shape for this: `source` + `installationId`
 * already encode "which owner, which action". These helpers only translate
 * between that pair and the two controls.
 */

import { githubOwnerKind } from '@/lib/github-installations';

import { withRepositoryChoice } from './github-source';
import type { NewWorkspaceFormState, RepositorySource } from './new-workspace-form';

export const MANAGED_ACCOUNT_VALUE = 'managed';

export interface GitAccountOption {
  /** The `<Select>` value. A GitHub installation id, or `managed`. */
  value: string;
  kind: 'github' | 'managed';
  /** The GitHub App installation this owner is reached through. Null for `managed`. */
  installationId: string | null;
  /** The GitHub owner login, for the row's label. Null for `managed`. */
  ownerLogin: string | null;
  /** GitHub's own `account.type`: `User` or `Organization`. Null for `managed`. */
  ownerType: string | null;
}

export interface RepositoryConnection {
  installation_id: string | null;
  owner_login: string | null;
  owner_type?: string | null;
}

/** What to do under a GitHub owner. `managed` has no such choice. */
export type RepositoryAction = 'create' | 'import';

/**
 * Every git account this Kortix account can put a repository under, in
 * display order.
 *
 * `managedConfigured === false` omits the managed option entirely rather than
 * offering one that answers 503 on submit — `getManagedGitBackend()` is what
 * the caller reads for it.
 */
export function gitAccountOptions(
  connections: readonly RepositoryConnection[],
  managedConfigured: boolean,
): GitAccountOption[] {
  const options: GitAccountOption[] = [];
  for (const connection of connections) {
    const installationId = connection.installation_id;
    if (!installationId) continue;
    options.push({
      value: installationId,
      kind: 'github',
      installationId,
      ownerLogin: connection.owner_login,
      ownerType: connection.owner_type ?? null,
    });
  }
  if (managedConfigured) {
    options.push({
      value: MANAGED_ACCOUNT_VALUE,
      kind: 'managed',
      installationId: null,
      ownerLogin: null,
      ownerType: null,
    });
  }
  return options;
}

/**
 * What the form should start on: the account's first GitHub connection when it
 * has one, `Kortix managed` otherwise.
 *
 * Null when the account has neither — the page then offers "Add a GitHub
 * account" instead of a select with nothing in it.
 */
export function defaultGitAccount(options: readonly GitAccountOption[]): GitAccountOption | null {
  return options[0] ?? null;
}

/** The option the current form state names, or null when it names an option
 *  that is gone from the list (a connection was disconnected, say). */
export function selectedGitAccount(
  options: readonly GitAccountOption[],
  state: Pick<NewWorkspaceFormState, 'source' | 'installationId'>,
): GitAccountOption | null {
  const value = state.source === 'managed' ? MANAGED_ACCOUNT_VALUE : (state.installationId ?? '');
  return options.find((option) => option.value === value) ?? null;
}

/** The option a `<Select>` value names. Null for a value from a stale list. */
export function parseGitAccount(
  options: readonly GitAccountOption[],
  value: string,
): GitAccountOption | null {
  return options.find((option) => option.value === value) ?? null;
}

/** The action the form state encodes. `create` for anything that is not an import. */
export function repositoryAction(state: Pick<NewWorkspaceFormState, 'source'>): RepositoryAction {
  return state.source === 'github-import' ? 'import' : 'create';
}

/**
 * Whether creating a repository under this git account needs the user's own
 * GitHub authorization first.
 *
 * A personal account does. GitHub accepts the account's App installation token
 * on `POST /orgs/{org}/repos` but not on `POST /user/repos`, so a personal
 * create runs on a GitHub App USER access token instead. The server asks for
 * one with `409 github_user_authorization_required`, and `/new` answers it with
 * a single popup (`github-user-authorization.ts`).
 */
export function createNeedsGitHubAuthorization(option: GitAccountOption): boolean {
  return githubOwnerKind(option.ownerType) === 'personal';
}

function sourceFor(kind: GitAccountOption['kind'], action: RepositoryAction): RepositorySource {
  if (kind === 'managed') return 'managed';
  return action === 'import' ? 'github-import' : 'github-create';
}

/**
 * Apply a git-account pick. The action carries over between GitHub owners
 * (a user importing from one org who switches to another is still importing);
 * `managed` has no action. Delegates the clearing rules to
 * `withRepositoryChoice`, so a switch never leaks a repository or a branch
 * across owners.
 */
export function withGitAccount(
  state: NewWorkspaceFormState,
  option: GitAccountOption,
): NewWorkspaceFormState {
  return withRepositoryChoice(state, {
    kind: sourceFor(option.kind, repositoryAction(state)),
    installationId: option.installationId,
  });
}

/**
 * Apply an action pick under the current GitHub owner. A no-op for `managed`,
 * which has no action to pick.
 */
export function withRepositoryAction(
  state: NewWorkspaceFormState,
  action: RepositoryAction,
): NewWorkspaceFormState {
  if (state.source === 'managed') return state;
  if (repositoryAction(state) === action) return state;
  return withRepositoryChoice(state, {
    kind: sourceFor('github', action),
    installationId: state.installationId,
  });
}
