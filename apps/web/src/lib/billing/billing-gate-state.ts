import type { UiTranslator } from '@/i18n/translator';
/**
 * The ONE place the web asks "what is this account's billing situation, and
 * what should we say about it?".
 *
 * Every blocking surface used to answer it for itself, and they disagreed:
 *
 * - the session page treated `credits.can_run === false` as `noPlan` and
 *   rendered "Your team isn't on a plan yet — Subscribe to Team plan";
 * - the modal that CTA opened branched on `billing_model === 'per_seat' ||
 *   has_subscription` and rendered "Out of credits — your Team plan and seats
 *   are unaffected";
 * - the project page keyed off `tier_key === 'free' | 'none'`;
 * - the sidebar keyed off the raw balance.
 *
 * So a Team account on an ACTIVE $40/mo subscription with a $0.0099 wallet was
 * told it had no plan by one surface and told its plan was fine by the next.
 * `can_run: false` means BLOCKED. It has never meant "no plan".
 *
 * The API now sends `billing_state` (apps/api/src/billing/services/billing-state.ts).
 * We prefer it, and derive the same answer client-side when talking to an older
 * API so a rolling deploy can't resurrect the wrong copy.
 */

import type { UpgradeReason } from '@/stores/upgrade-dialog-store';
import type { AccountState, BillingState } from '@kortix/sdk';

export type { BillingState };

const KNOWN_STATES: readonly BillingState[] = [
  'active',
  'out_of_credits',
  'no_subscription',
  'payment_failed',
  'no_account',
];

const DEAD_SUBSCRIPTION_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);
const FAILING_STATUSES = new Set(['past_due', 'unpaid', 'incomplete', 'incomplete_expired']);

export type AccountStateLike = Pick<
  AccountState,
  'billing_state' | 'has_active_subscription' | 'billing_model'
> & {
  credits?: { can_run?: boolean | null; total?: number | null } | null;
  subscription?: { subscription_id?: string | null; status?: string | null } | null;
  tier?: { can_purchase_credits?: boolean | null } | null;
};

function isBillingState(value: unknown): value is BillingState {
  return typeof value === 'string' && (KNOWN_STATES as readonly string[]).includes(value);
}

/** Whether the account currently has a subscription that provides service. */
export function accountHasLiveSubscription(state: AccountStateLike | null | undefined): boolean {
  if (!state) return false;
  if (typeof state.has_active_subscription === 'boolean') return state.has_active_subscription;
  const id = state.subscription?.subscription_id;
  if (!id) return false;
  return !DEAD_SUBSCRIPTION_STATUSES.has(state.subscription?.status ?? '');
}

/**
 * Resolve the account's billing state. Returns `null` while account state is
 * unknown — callers must NOT treat "not loaded" as "blocked".
 */
export function resolveBillingState(
  state: AccountStateLike | null | undefined,
): BillingState | null {
  if (!state) return null;
  if (isBillingState(state.billing_state)) return state.billing_state;

  // Fallback derivation for an API that predates `billing_state`.
  //
  // It must mirror apps/api/src/billing/services/billing-state.ts exactly. Two
  // copies of this decision disagreeing is the defect class this module exists
  // to prevent, so every line below has a counterpart there.
  //
  // `can_run` is the server's own answer and outranks everything: since the
  // wallet floor became universal it is derived from `resolveBillingState`
  // server-side (account-state.ts), so trusting it cannot smuggle the old
  // exemption back in.
  if (state.credits?.can_run === true) return 'active';
  if (FAILING_STATUSES.has(state.subscription?.status ?? '')) return 'payment_failed';
  // REMOVED: `accountHasLiveSubscription(state) && billing_model === 'per_seat'
  // -> 'active'`. That was the client's copy of `subscriptionBypassesWalletFloor`,
  // and it would have re-rendered a drained Team account as fully runnable — on
  // a rolling deploy, against a server that had already started blocking it.
  // Nothing bypasses the wallet floor on either side of the wire now.
  if (state.subscription?.subscription_id || state.tier?.can_purchase_credits) {
    return 'out_of_credits';
  }
  return 'no_subscription';
}

/** Whether the account may start work. Unknown state is never "blocked". */
export function billingStateAllowsRun(state: BillingState | null): boolean {
  return state === null || state === 'active';
}

/** Whether adding credits (not subscribing) is what unblocks the account. */
export function billingStateNeedsTopUp(state: BillingState | null): boolean {
  return state === 'out_of_credits' || state === 'payment_failed';
}

/** Warn below this wallet value (dollars) on an account that is still running. */
export const LOW_BALANCE_USD = 5;

export type WalletSeverity = 'blocked' | 'low' | null;

/**
 * How loudly the wallet should be flagged. THE only function allowed to turn a
 * balance into a severity — see the source test in billing-gate-state.test.ts.
 *
 * The sidebar used to answer this itself with `balance <= 0 ? 'empty' : ...`,
 * reading the raw number and never consulting `billing_state`. Against an
 * account that the server considered `active` (a paying per-seat subscription
 * bypassed the wallet floor, so $0.00 was a perfectly runnable state) that
 * produced a permanent red "Out of credits" alert on an account with nothing
 * wrong with it — while the project page beside it, which DID read
 * `billing_state`, happily started sessions. Two surfaces, one account,
 * opposite answers. That is the defect this module's docblock was written to
 * prevent and it recurred anyway, because prose does not enforce anything.
 *
 * `blocked` is now derived from the state machine, never from the number. The
 * number is consulted only for the softer "you are running low" nudge, which is
 * meaningless on an account that is already blocked.
 */
export function walletSeverity(state: AccountStateLike | null | undefined): WalletSeverity {
  if (!state) return null;
  const billingState = resolveBillingState(state);
  // Not loaded yet — never render an alarm on an unknown account.
  if (billingState === null) return null;
  if (billingStateNeedsTopUp(billingState)) return 'blocked';
  if (!billingStateAllowsRun(billingState)) return null; // `no_subscription` / `no_account` own their own CTA.
  const balance = state.credits?.total;
  if (typeof balance !== 'number') return null;
  return balance < LOW_BALANCE_USD ? 'low' : null;
}

/**
 * Copy for the sidebar wallet alert. Here rather than in the component for the
 * same reason as `billingModalCopy`: the strings a user reads about billing are
 * a function of billing state, and a component that writes its own is a
 * component that can contradict the server.
 */
export function walletAlertCopy(
  severity: Exclude<WalletSeverity, null>,
  tI18nComplete: UiTranslator,
): {
  label: string;
  action: string;
} {
  return severity === 'blocked'
    ? { label: tI18nComplete.raw('textf1c24ec92034'), action: 'Top up' }
    : { label: tI18nComplete.raw('text9757b0277bb1'), action: 'Top up' };
}

export interface BillingModalCopy {
  title: string;
  description: string;
}

/**
 * Copy for the billing modal. Lives here, beside `billingGateCopy`, so no
 * component owns billing prose.
 *
 * The modal used to hardcode the title `'Out of credits'` and the line "your
 * Team plan and seats are unaffected", branching only on `payment_failed`. It
 * therefore announced an emergency to accounts that were merely topping up
 * voluntarily, and promised "seats are unaffected" to accounts that had no
 * seats. Both strings are now a function of the state and the billing model.
 */
export function billingModalCopy(
  state: BillingState | null,
  opts: { isPerSeat?: boolean } | undefined,
  tI18nComplete: UiTranslator,
): BillingModalCopy {
  const planNoun = opts?.isPerSeat ? 'your Team plan and seats are' : 'your plan is';
  switch (state) {
    case 'payment_failed':
      return {
        title: tI18nComplete.raw('text796a79862546'),
        description: tI18nComplete.raw('textce0c20c05842'),
      };
    case 'out_of_credits':
      return {
        title: tI18nComplete.raw('textf1c24ec92034'),
        description: tI18nComplete('text5ecbbab0d8d8', { value0: planNoun }),
      };
    case 'no_account':
      return {
        title: tI18nComplete.raw('text72298eb4f45a'),
        description: tI18nComplete.raw('text96af819328e8'),
      };
    case 'no_subscription':
      return {
        title: tI18nComplete.raw('text51d7edea32d3'),
        description: tI18nComplete.raw('textdbc55cb506f2'),
      };
    default:
      // `active` — a voluntary top-up. Nothing is wrong, so nothing alarming.
      return {
        title: tI18nComplete.raw('textd22feb61298b'),
        description: tI18nComplete('texta1ec2c7ae89a', { value0: planNoun }),
      };
  }
}

export interface BillingGateCopy {
  title: string;
  message: string;
  ctaLabel: string;
  /** The `reason` the CTA opens the global billing modal with — so the copy on
   *  the gate and the copy in the modal can never contradict each other. */
  dialogReason: UpgradeReason;
}

/**
 * Copy for a BLOCKING state. `active` has no gate copy by construction, so
 * callers must check `billingStateAllowsRun` first.
 */
export function billingGateCopy(
  state: Exclude<BillingState, 'active'>,
  tI18nComplete: UiTranslator,
): BillingGateCopy {
  switch (state) {
    case 'out_of_credits':
      return {
        title: tI18nComplete.raw('textf1c24ec92034'),
        message: tI18nComplete.raw('text109346f4fd22'),
        ctaLabel: 'Top up credits',
        dialogReason: 'insufficient_credits',
      };
    case 'payment_failed':
      return {
        title: tI18nComplete.raw('text796a79862546'),
        message: tI18nComplete.raw('text3b7d044b6a4c'),
        ctaLabel: 'Fix payment',
        dialogReason: 'insufficient_credits',
      };
    case 'no_account':
      return {
        title: tI18nComplete.raw('text72298eb4f45a'),
        message: tI18nComplete.raw('text5b31ffa81ee2'),
        ctaLabel: 'Set up billing',
        dialogReason: 'no_account',
      };
    default:
      return {
        title: tI18nComplete.raw('text51d7edea32d3'),
        message: tI18nComplete.raw('textdbc55cb506f2'),
        ctaLabel: 'Subscribe to Team plan',
        dialogReason: 'subscription_required',
      };
  }
}

/** The payload every surface should open the billing modal with. */
export function billingDialogArgs(
  state: BillingState | null,
  accountState: AccountStateLike | null | undefined,
  accountId: string | undefined,
  tI18nComplete: UiTranslator,
): {
  reason: UpgradeReason;
  accountId?: string;
  billingModel?: string;
  hasSubscription?: boolean;
  billingState?: BillingState;
  balance?: number;
} {
  const resolved = state ?? 'no_subscription';
  // Opening the billing modal on an ACTIVE account is always a voluntary
  // top-up (the low-balance nudge in the sidebar) — never a subscribe pitch.
  const reason: UpgradeReason =
    resolved === 'active'
      ? 'insufficient_credits'
      : billingGateCopy(resolved, tI18nComplete).dialogReason;
  return {
    reason,
    accountId,
    billingModel: accountState?.billing_model ?? undefined,
    hasSubscription: accountHasLiveSubscription(accountState),
    billingState: resolved,
    balance: accountState?.credits?.total ?? undefined,
  };
}
