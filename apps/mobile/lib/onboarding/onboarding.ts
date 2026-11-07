/**
 * First-run onboarding (COR-161, Workspaces D3): sign up → `/new`, the
 * create-or-join screen → the workspace's home. No workspace is created at
 * sign-up: a new user has 0 accounts until they create or join one. The decisions, as pure functions (tested in
 * onboarding.test.ts); the screens are `app/index.tsx`, `app/welcome.tsx`
 * and `app/new.tsx`.
 *
 * - Where the app opens (`startDestination`): a pending invite first; then a
 *   workspace when the user has one (the last one opened, else the first —
 *   `lib/projects/landing.ts`). A workspace is a project and its account; an
 *   account with 0 projects is not a workspace.
 *   With no workspace: `/new` (create or join). The upgrade screen comes
 *   first only when the user already holds an account (an empty one kept
 *   from before D3, whose plan the new workspace keeps) and has not seen it.
 *   A user with a workspace never sees the upgrade screen.
 * - Which account the upgrade screen shows (`onboardingAccountId`).
 * - What the upgrade screen offers (`welcomeOffer`): App Store guideline
 *   3.1.1 (`lib/billing/store-policy.ts`) — iOS shows the plan and its
 *   benefits with Continue with Free only; Android and web add Upgrade,
 *   which opens web billing. An account already on a paid plan skips the
 *   screen.
 *
 * No react-native import here: callers pass `Platform.OS`.
 */

import type { PlanFamily } from '@/lib/billing/plan-action';
import { canShowExternalPurchase } from '@/lib/billing/store-policy';
import { getUpgradeSheetIncludedItems } from '@/lib/billing/upgrade-sheet-included';
import { creatableAccounts, type CreateVerdicts, type LandingResolution } from '@/lib/projects/landing';
import type { KortixAccount } from '@/lib/projects/projects-client';

export type StartDestination =
  | { kind: 'invite'; inviteId: string }
  | { kind: 'project'; projectId: string; accountId: string }
  | { kind: 'welcome' }
  | { kind: 'new' };

/**
 * Where the start screen sends a signed-in user. A pending invite comes first
 * (web `decideDoor`): an invite stays pending until it is accepted, so
 * without this an invitee lands on the create screen (KRTX-1731).
 * `skipped` holds the invites put off with Not now. `accountCount` is the
 * number of accounts the user belongs to: with none there is no plan to
 * offer, so the upgrade screen never shows and `/new` opens at once.
 */
export function startDestination(
  landing: LandingResolution,
  upgradeSeen: boolean,
  invites: ReadonlyArray<{ invite_id: string }> = [],
  skipped: ReadonlySet<string> = new Set(),
  accountCount = 1
): StartDestination {
  const invite = invites.find((pending) => !skipped.has(pending.invite_id));
  if (invite) return { kind: 'invite', inviteId: invite.invite_id };
  if (landing.kind === 'project') return landing;
  return upgradeSeen || accountCount === 0 ? { kind: 'new' } : { kind: 'welcome' };
}

/**
 * The account the upgrade screen shows the plan of: the selected account
 * when a project can be created in it (`project.create` verdict), else the
 * first account where one can, else the selected account, else the first
 * account, else null (no account: a new user under D3).
 */
export function onboardingAccountId(
  accounts: KortixAccount[],
  selectedAccountId: string | null,
  verdicts: CreateVerdicts
): string | null {
  const creatable = creatableAccounts(accounts, verdicts);
  if (creatable.some((account) => account.account_id === selectedAccountId)) return selectedAccountId;
  if (creatable[0]) return creatable[0].account_id;
  if (accounts.some((account) => account.account_id === selectedAccountId)) return selectedAccountId;
  return accounts[0]?.account_id ?? null;
}

/**
 * The upgrade screen's primary action.
 * - `upgrade`: opens web billing (Android, web).
 * - `ask-owner`: the user cannot manage billing — a read-only line.
 * - `none`: iOS, where no purchase call to action is allowed.
 */
export type WelcomeAction = 'upgrade' | 'ask-owner' | 'none';

export interface WelcomeOffer {
  /** False: the account is already on a paid plan — go straight to `/new`. */
  show: boolean;
  action: WelcomeAction;
  /** The plan's benefit lines (the upgrade sheet's Includes list, first four). */
  benefits: string[];
}

/** The number of benefit lines on the upgrade screen. */
export const WELCOME_BENEFIT_COUNT = 4;

export function welcomeOffer(input: {
  os: string;
  family: PlanFamily;
  canManageBilling: boolean;
}): WelcomeOffer {
  const canPurchase = canShowExternalPurchase(input.os);
  const benefits = getUpgradeSheetIncludedItems().slice(0, WELCOME_BENEFIT_COUNT);
  const action: WelcomeAction = !canPurchase ? 'none' : input.canManageBilling ? 'upgrade' : 'ask-owner';
  return { show: input.family === 'free', action, benefits };
}
