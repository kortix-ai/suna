/**
 * First-run onboarding (COR-161): sign up → upgrade screen (once) → `/new` →
 * project home. The decisions, as pure functions (tested in
 * onboarding.test.ts); the screens are `app/index.tsx`, `app/welcome.tsx`
 * and `app/new.tsx`.
 *
 * - Where the app opens (`startDestination`): a project when any account has
 *   one (the last one opened, else the first — `lib/projects/landing.ts`).
 *   With no project anywhere: the upgrade screen if this user has not seen
 *   it, else `/new`. A user with a project never sees the upgrade screen.
 * - Which account the first project goes to (`onboardingAccountId`).
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
import { creatableAccounts, type LandingResolution } from '@/lib/projects/landing';
import type { KortixAccount } from '@/lib/projects/projects-client';

export type StartDestination =
  | { kind: 'project'; projectId: string; accountId: string }
  | { kind: 'welcome' }
  | { kind: 'new' };

/** Where the start screen sends a signed-in user. */
export function startDestination(landing: LandingResolution, upgradeSeen: boolean): StartDestination {
  if (landing.kind === 'project') return landing;
  return upgradeSeen ? { kind: 'new' } : { kind: 'welcome' };
}

/**
 * The account the upgrade screen and `/new` start on: the selected account
 * when a project can be created in it, else the first account the user owns
 * or administers, else the selected account, else the first account.
 */
export function onboardingAccountId(
  accounts: KortixAccount[],
  selectedAccountId: string | null
): string | null {
  const creatable = creatableAccounts(accounts);
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
  pricePerSeat: number;
}): WelcomeOffer {
  const canPurchase = canShowExternalPurchase(input.os);
  const benefits = getUpgradeSheetIncludedItems(input.pricePerSeat, canPurchase).slice(
    0,
    WELCOME_BENEFIT_COUNT
  );
  const action: WelcomeAction = !canPurchase ? 'none' : input.canManageBilling ? 'upgrade' : 'ask-owner';
  return { show: input.family === 'free', action, benefits };
}
