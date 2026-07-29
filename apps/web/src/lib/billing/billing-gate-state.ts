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
const FAILING_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);

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
  if (state.credits?.can_run === true) return 'active';
  if (accountHasLiveSubscription(state) && state.billing_model === 'per_seat') return 'active';
  if (FAILING_STATUSES.has(state.subscription?.status ?? '')) return 'payment_failed';
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
export function billingGateCopy(state: Exclude<BillingState, 'active'>): BillingGateCopy {
  switch (state) {
    case 'out_of_credits':
      return {
        title: 'Out of credits',
        message:
          'Your wallet is empty, so sessions can’t run. Top up to keep compute and the latest AI models going — your plan and seats are unaffected.',
        ctaLabel: 'Top up credits',
        dialogReason: 'insufficient_credits',
      };
    case 'payment_failed':
      return {
        title: 'Payment issue on your plan',
        message:
          'Your last payment didn’t go through and your wallet is empty. Update your payment method or top up to start sessions again.',
        ctaLabel: 'Fix payment',
        dialogReason: 'insufficient_credits',
      };
    case 'no_account':
      return {
        title: 'Finish setting up billing',
        message:
          'This account has no billing set up yet, so sessions can’t start. Choose a plan to continue.',
        ctaLabel: 'Set up billing',
        dialogReason: 'no_account',
      };
    default:
      return {
        title: 'Subscribe to start sessions',
        message:
          'Your team isn’t on a plan yet. Subscribe to Kortix Team to run sessions, with LLM compute and AI Computers for every teammate.',
        ctaLabel: 'Subscribe to Team plan',
        dialogReason: 'subscription_required',
      };
  }
}

/** The payload every surface should open the billing modal with. */
export function billingDialogArgs(
  state: BillingState | null,
  accountState: AccountStateLike | null | undefined,
  accountId?: string,
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
    resolved === 'active' ? 'insufficient_credits' : billingGateCopy(resolved).dialogReason;
  return {
    reason,
    accountId,
    billingModel: accountState?.billing_model ?? undefined,
    hasSubscription: accountHasLiveSubscription(accountState),
    billingState: resolved,
    balance: accountState?.credits?.total ?? undefined,
  };
}
