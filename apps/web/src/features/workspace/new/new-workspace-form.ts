import type { ProjectIconValue } from '@/features/projects/modal/project-icon-field';
import { githubSourceReady } from '@/features/workspace/new/github-source';
import { validateWorkspaceName } from '@/features/workspace/new/workspace-name';
import type { KortixAccount } from '@kortix/sdk';

export type RepositorySource = 'managed' | 'github-create' | 'github-import';

export interface NewWorkspaceFormState {
  name: string;
  icon: ProjectIconValue;
  source: RepositorySource;
  defaultBranch: string;
  /** Null means "the user has exactly one account, so there is nothing to pick". */
  accountId: string | null;
  /**
   * The GitHub App installation the two GitHub sources act through — the
   * `installation_id` both `POST /projects/create-repo` and
   * `POST /projects/link-repository` require. Null for `managed`, which needs
   * no GitHub account at all.
   */
  installationId: string | null;
  /** `owner/repo`, for `github-import` only. Null for the other two sources. */
  repoFullName: string | null;
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
  accountId: null,
  installationId: null,
  repoFullName: null,
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
 *
 * Does NOT strip the `'s Account` possessive `bootstrap-personal-account.ts`
 * stores on every personal account's `name`. That possessive is the only
 * thing that marks the string as an account name rather than a bare email —
 * stripping it here used to hand `AccountPicker` a value indistinguishable
 * from `user.email`, which it then painted straight into the identity slot.
 * An invited admin whose one creatable account is the owner's personal
 * account saw the account owner's address labelled as their own identity.
 * `AccountPicker` now renders `fallbackLabel` in that slot and this `name`
 * only in the separate, explicitly labelled "Create in" line — never merged.
 */
export function filterCreatableAccounts(accounts: KortixAccount[]): KortixAccount[] {
  const creatable: KortixAccount[] = [];
  for (const account of accounts) {
    if (account.account_role === 'owner' || account.account_role === 'admin') {
      creatable.push({
        ...account,
        name: account.name.trim(),
      });
    }
  }
  return creatable;
}

/**
 * Which creatable account `/new` should pre-select.
 *
 * Preference order:
 * 1. Identity — `account_id === userId`. Personal accounts are created with
 *    `accountId === userId` by construction
 *    (`apps/api/src/accounts/core/bootstrap-personal-account.ts`: "Personal
 *    accounts use `accountId === userId`"), so this is the only tier that can
 *    distinguish the account that IS the user from an account the user
 *    merely owns or administers. Replaces two tiers that were permanently
 *    dead against the real `GET /v1/accounts` shape: `name` always carries
 *    the `'s Account` possessive (`filterCreatableAccounts` stopped
 *    stripping it, Task 1), and `slug` is `accountId.slice(0, 8)`
 *    (`apps/api/src/accounts/core/accounts.ts:122`) — never an email or its
 *    local part.
 * 2. `is_primary_owner` — true for any account this user owns outright
 *    (`accountRole === 'owner'`, `apps/api/src/accounts/core/accounts.ts:126`),
 *    including a team account that is NOT their personal one. Kept as a
 *    fallback for when identity does not resolve (`userId` not loaded yet,
 *    or the sole owned account is a team account) — the same proxy
 *    marketplace/install dialogs use when there is no `personal_account`
 *    flag on the API.
 * 3. The first creatable account — no signal at all to prefer one over
 *    another.
 *
 * Pure and Effect-free so `/new` can derive the default without writing to
 * state on mount (the page forbids `useEffect`).
 */
export function resolveDefaultCreatableAccountId(
  accounts: KortixAccount[],
  userId?: string | null,
): string | null {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0]!.account_id;

  if (userId) {
    const own = accounts.find((account) => account.account_id === userId);
    if (own) return own.account_id;
  }

  const primary = accounts.find((account) => account.is_primary_owner);
  if (primary) return primary.account_id;

  return accounts[0]!.account_id;
}

/**
 * A creatable-accounts list the viewer's identity cannot be anchored to: two
 * or more accounts, none of them the viewer's own (`account_id === userId`).
 *
 * Deliberately excludes a SOLE foreign account. `GET /v1/accounts` only ever
 * returns accounts this specific signed-in user is a genuine member of
 * (`accountMembers.userId = userId`, `apps/api/src/accounts/core/accounts.ts`),
 * and `filterCreatableAccounts` further narrows that to owner/admin roles —
 * so a SOLE creatable account that is not the viewer's own is the ordinary
 * invited-admin shape: someone added as admin on an account before ever
 * having their own personal account bootstrapped (`bootstrapPersonalAccount`
 * only fires when the caller has ZERO existing memberships,
 * `apps/api/src/accounts/core/accounts.ts`). That is legitimate and common,
 * not a leak — it is exactly the scenario Task 1's fix protects (Task 2
 * controller addendum A2.2), so it is never FOREIGN on its own.
 *
 * The N=1 case this function CANNOT catch, and no longer has to: a SOLE
 * foreign account (the branch above that returns `false`) used to be
 * INDISTINGUISHABLE, from this function's inputs alone, from a stale account
 * list still holding a DIFFERENT, previously-signed-in user's single-account
 * list. Both shapes are exactly one account, `account_id !== userId`, so
 * rejecting one would have permanently locked legitimate invited admins out
 * of creating any workspace. That gap is closed one layer up instead,
 * structurally: the account list is cached under `qk.accounts.list(userId)`
 * (`packages/sdk/src/react/query-keys.ts`), read only through
 * `useAccountsList()` (`hooks/account/use-accounts-list.ts`), and every
 * reader is gated `enabled: !!user`. A previous user's list — of ANY size,
 * not only one account — is not ADDRESSABLE from this user's session, so it
 * cannot reach this function at all any more.
 *
 * WHAT THAT MEANS FOR THE 2+-ACCOUNT CASE THIS FUNCTION ACTUALLY GUARDS:
 * before the key scoping above, a 2+-account list with no anchor to the
 * viewer had TWO possible causes — (a) a stale or wrong cache entry left by a
 * DIFFERENT signed-in user, or (b) a genuine, still-rare shape: a user who
 * owns/admins 2+ team accounts and has no personal account of their own, so
 * none of their creatable accounts is `account_id === userId`. The key
 * scoping above closes (a) the same way it closes the N=1 case — a previous
 * user's list cannot reach this function at all. It does NOT close (b): that
 * user's OWN list, correctly scoped to their OWN session, still has zero
 * anchor to their identity, because their identity genuinely has no
 * creatable account of its own. So today the ONLY reachable trigger for this
 * predicate is (b), a legitimate user, not a caching defect — reachable via
 * SAML JIT provisioning (`iam/sso-sync.ts` inserting a membership directly)
 * or direct invite acceptance (`accounts/invites.ts`), either of which can
 * add someone as owner/admin on 2+ accounts without ever running the
 * `memberships.length === 0` personal-account bootstrap gate.
 *
 * This check still earns its place and must NOT be deleted or relaxed: (b)
 * is real, and this function still cannot tell "a genuine multi-account user
 * with no personal account" apart from any other reason a response might
 * carry zero anchor to the viewer — guessing which of 2+ unrelated accounts
 * is safe to default into is worse than refusing to guess (G2, fail-closed).
 * What changed is the caller's obligation: since the reachable trigger is now
 * a LEGITIMATE user rather than a caching artifact, `new-workspace-page.tsx`
 * must render that user a REASON, not a silently disabled form — see its own
 * comment where `foreignAccountList` is read.
 *
 * `userId` is required, not optional: an omitted argument used to compile
 * clean and silently degrade to `undefined`, which made every 2+-account
 * list FOREIGN by accident (a functional break for real multi-account users,
 * not a security hole, but one no single-account test could catch). The type
 * also does not accept `undefined` at all — only `string | null` — so a
 * caller that cannot yet establish identity must say so explicitly with
 * `null` rather than by omission. `null` already fails closed correctly: no
 * real `account_id` is ever `null`, so `!some(...)` is `true` for any 2+
 * list, exactly the G2 fail-closed direction this function exists for.
 */
export function isForeignAccountList(
  creatableAccounts: KortixAccount[],
  userId: string | null,
): boolean {
  if (creatableAccounts.length < 2) return false;
  return !creatableAccounts.some((account) => account.account_id === userId);
}

/**
 * Whether `AccountPicker` should reveal any account-specific info beyond
 * bare identity — the caller-side half of A2.2 / item 2's suppression rules.
 *
 * `AccountPicker` always receives the REAL, unmodified `creatableAccounts` —
 * this function returns a boolean, never a shrunk stand-in list, precisely
 * because handing the component a falsified `accounts` array (this used to
 * return `[]` to suppress) makes `accounts` stop meaning "the accounts the
 * user can create in" while `value` still names one of them, a standing trap
 * for anyone who later changes `AccountPicker`'s own length thresholds or
 * adds a second consumer of `accounts`. `AccountPicker`'s own
 * `showAccountLine` prop is what actually acts on this.
 *
 * `false` (suppress) for:
 * - A SOLE account that IS the viewer's own (`account_id === userId`): a
 *   user's own email directly above "Create in jay@kortix.ai's Account" is
 *   redundant, not informative (Task 2 controller addendum A2.2).
 * - A FOREIGN list (`isForeignAccountList`): no account name renders at all
 *   (Task 2 item 2, G2 fail-closed).
 *
 * `true` (reveal) for everything else, INCLUDING a sole foreign account (the
 * invited-admin case) — that account's name must still render; suppressing
 * it would re-open the exact disclosure Task 1 closed.
 */
export function shouldShowAccountLine(
  creatableAccounts: KortixAccount[],
  userId: string | null,
): boolean {
  if (isForeignAccountList(creatableAccounts, userId)) return false;
  const sole = creatableAccounts.length === 1 ? creatableAccounts[0]! : null;
  if (sole && sole.account_id === userId) return false;
  return true;
}

export function isSubmittable(state: NewWorkspaceFormState, accountCount: number): boolean {
  if (!validateWorkspaceName(state.name).ok) return false;
  // The two GitHub sources need inputs `managed` does not: an installation for
  // both, and a repository for `github-import`. Gated HERE rather than at the
  // page, which is where the old `state.source === 'managed'` blanket refusal
  // lived — that one disabled submit for a correctly-filled GitHub form as
  // readily as an empty one, because no GitHub form existed to fill.
  if (!githubSourceReady(state)) return false;
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

  if (state.accountId) payload.account_id = state.accountId;

  return payload;
}
