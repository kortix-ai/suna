import type { ProjectIconValue } from '@/features/projects/modal/project-icon-field';
import { validateWorkspaceName } from '@/features/workspace/new/workspace-name';
import type { KortixAccount } from '@kortix/sdk';

export type RepositorySource = 'managed' | 'github-create' | 'github-import';

export interface NewWorkspaceFormState {
  name: string;
  icon: ProjectIconValue;
  source: RepositorySource;
  defaultBranch: string;
  templateId: string | null;
  /** Null means "the user has exactly one account, so there is nothing to pick". */
  accountId: string | null;
}

/**
 * `managed` is the default because `projects.repo_url` is NOT NULL — every
 * workspace has a repo, and a name-only create has to choose one. Kortix
 * managing it is the only option that needs no GitHub account and no
 * repo-name uniqueness.
 */
export const INITIAL_FORM_STATE: NewWorkspaceFormState = {
  name: '',
  icon: null,
  source: 'managed',
  defaultBranch: 'main',
  templateId: null,
  accountId: null,
};

/**
 * Accounts the signed-in user may actually create a workspace in — owner or
 * admin. `POST /provision` requires `ACCOUNT_ACTIONS.PROJECT_CREATE` and
 * returns 403 "Owner or admin role required" for anyone else
 * (`apps/api/src/projects/routes/r1.ts:462`), so offering any other account
 * would be a choice that can only fail: the user fills in a name, presses
 * Create, and gets a 403 with no warning.
 *
 * Same predicate as `create-account-selection.ts`'s `options` filter, so the
 * two never disagree about who can create a workspace while both exist.
 *
 * `account_role` is optional on `KortixAccount` — an account with no role at
 * all is excluded too (`undefined !== 'owner'`), the same fail-closed
 * direction the modal's filter takes.
 *
 * Called exactly ONCE per render, in `new-workspace-page.tsx`, and the result
 * feeds both `AccountPicker` and `isSubmittable` below — never the raw list
 * to one and this to the other, which would let "what the user can pick" and
 * "what gates submit" disagree.
 */
export function filterCreatableAccounts(accounts: KortixAccount[]): KortixAccount[] {
  return accounts.filter(
    (account) => account.account_role === 'owner' || account.account_role === 'admin',
  ).map((account) => ({
    ...account,
    name: account.name.trim().replaceAll('\'s Account', ''),
  }));
}

/**
 * Which creatable account `/new` should pre-select.
 *
 * Preference order:
 * 1. Account `name` equals the signed-in email (case-insensitive) — the
 *    personal / bootstrapped account is often titled with the email.
 * 2. Account `slug` equals the email or its local-part.
 * 3. `is_primary_owner` — same proxy marketplace/install dialogs use when
 *    there is no `personal_account` flag on the API.
 * 4. The first creatable account.
 *
 * Pure and Effect-free so `/new` can derive the default without writing to
 * state on mount (the page forbids `useEffect`).
 */
export function resolveDefaultCreatableAccountId(
  accounts: KortixAccount[],
  email?: string | null,
): string | null {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0]!.account_id;

  const normalized = email?.trim().toLowerCase() ?? '';
  if (normalized) {
    const byName = accounts.find((account) => account.name.trim().toLowerCase() === normalized);
    if (byName) return byName.account_id;

    const localPart = normalized.split('@')[0] ?? '';
    const bySlug = accounts.find((account) => {
      const slug = account.slug?.trim().toLowerCase() ?? '';
      if (!slug) return false;
      return slug === normalized || (localPart.length > 0 && slug === localPart);
    });
    if (bySlug) return bySlug.account_id;
  }

  const primary = accounts.find((account) => account.is_primary_owner);
  if (primary) return primary.account_id;

  return accounts[0]!.account_id;
}

export function isSubmittable(state: NewWorkspaceFormState, accountCount: number): boolean {
  if (!validateWorkspaceName(state.name).ok) return false;
  // Zero is never a legitimate "ready to submit" state. It means either the
  // accounts query has not resolved yet — in which case a multi-account user
  // would submit with no account_id and the server would silently fall back to
  // a default account — or the user genuinely has no account to create in.
  // Both must block submission.
  if (accountCount < 1) return false;
  // With exactly one account there is nothing to disambiguate, so the picker is
  // not rendered and `accountId` stays null legitimately.
  if (accountCount > 1 && !state.accountId) return false;
  return true;
}

/**
 * The request body for `POST /v1/projects/provision`.
 *
 * Keys are omitted rather than sent as null: the API treats an absent icon key
 * as "no icon" and normalises invalid values by dropping them, so sending
 * `icon: null` and omitting it mean the same thing to the server but only the
 * omission is unambiguous to a reader of the network tab.
 *
 * `icon` and `icon_glyph` are NEVER both present. The union type makes that
 * unrepresentable here, which is why the icon is one field and not two nullable
 * slots.
 */
export function buildProvisionPayload(state: NewWorkspaceFormState): Record<string, unknown> {
  const validated = validateWorkspaceName(state.name);
  const payload: Record<string, unknown> = {
    name: validated.ok ? validated.name : state.name.trim(),
    seed_starter: true,
    default_branch: state.defaultBranch,
  };

  if (state.icon && 'emoji' in state.icon) payload.icon = state.icon.emoji;
  else if (state.icon && 'glyph' in state.icon) payload.icon_glyph = state.icon.glyph;

  if (state.templateId) payload.source_item_id = state.templateId;
  if (state.accountId) payload.account_id = state.accountId;

  return payload;
}
