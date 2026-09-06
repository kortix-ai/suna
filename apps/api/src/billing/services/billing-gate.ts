import { HTTPException } from 'hono/http-exception';
import { config } from '../../config';
import { getCreditAccount } from '../repositories/credit-accounts';
import {
  type BillingSnapshot,
  type BillingState,
  billingSnapshotFromAccount,
  billingStateAllowsRun,
  hasSubscriptionRecord,
  resolveBillingState,
} from './billing-state';
import { deductCredits } from './credits';
import { ensureFreeTierAccountReady } from './free-tier';
import { type BillingModel, MINIMUM_CREDIT_FOR_RUN, isPerSeatAccount } from './tiers';

type BillingGateReason = 'subscription_required' | 'insufficient_credits' | 'no_account';

export interface BillingGateOk {
  ok: true;
  // Set on every billing-enabled admission: this call ATOMICALLY reserved
  // (deducted) this many dollars from the account as an admission hold — see
  // the comment below. The caller (llm-gateway hooks) reconciles it against
  // the real cost at settle time (recordGatewayUsage) instead of a flat
  // post-hoc deduct.
  //
  // Absent ONLY when billing is disabled for the whole deploy (self-host).
  // It used to also be absent for a paying per-seat subscription, which
  // bypassed the floor entirely — that bypass is gone, and with it the
  // `billingHoldUsd == null` branch in hooks.ts that a bypassed account fell
  // into and that silently discarded its spend.
  holdUsd?: number;
}

export interface BillingGateBlocked {
  ok: false;
  reason: BillingGateReason;
  balance: number;
  message: string;
  // The account's billing model + whether it has a subscription row at all.
  // Carried on the 402 so the client can tell a genuinely-free/no-plan account
  // ("subscribe" pitch) apart from a paying Team account whose wallet ran dry
  // ("top up" pitch) — the same `subscription_required` reason otherwise
  // mislabels a per-seat Team account as Free. See web global-upgrade-modal.
  billingModel: BillingModel;
  hasSubscription: boolean;
  // The UNAMBIGUOUS state (billing-state.ts). `reason` is the legacy 402 error
  // code and is intentionally lossy — a `free` wallet at zero and a lapsed Team
  // wallet at zero both emit `insufficient_credits`, and a never-subscribed
  // per-seat account emits `subscription_required`. Clients should branch on
  // `billingState` and treat `reason` as the wire-compatible code only.
  billingState: BillingState;
}

/**
 * Thrown by `assertBillingActive` on a blocked account. A plain `HTTPException`
 * only exposes the real reason (`subscription_required` vs `insufficient_credits`
 * vs `no_account`) inside its JSON `res` body — which a caller can't read
 * without consuming the Response stream, so both the in-process pipeline
 * (`packages/llm-gateway`'s handler.ts `admit()`) and the out-of-process RPC
 * path (`authorizeRequest()` below) used to just hardcode `subscription_required`
 * for every 402 here. Carrying `.reason` directly on the thrown error lets both
 * read the real cause synchronously, no body parsing required.
 */
export class BillingGateError extends HTTPException {
  constructor(
    readonly reason: BillingGateReason,
    readonly balance: number,
    message: string,
    accountId: string,
    extra?: {
      billingModel?: BillingModel;
      hasSubscription?: boolean;
      billingState?: BillingState;
    },
  ) {
    super(402, {
      message,
      res: new Response(
        JSON.stringify({
          error: message,
          code: reason,
          balance,
          // Distinguish "no plan → subscribe" from "Team wallet drained → top up".
          billing_model: extra?.billingModel ?? 'legacy',
          has_subscription: extra?.hasSubscription ?? false,
          // The unambiguous state — what every client should branch on.
          billing_state: extra?.billingState ?? 'no_subscription',
          // The blocked account — so the upgrade dialog scopes to it instead of
          // the caller's primary account (see web error-handler → openUpgradeDialog).
          account_id: accountId,
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    });
  }
}

export async function checkBillingActive(
  accountId: string,
): Promise<BillingGateOk | BillingGateBlocked> {
  // Self-hosted / billing-disabled deploys treat every account as billing-active.
  // No subscription, no credit balance, no 402 — the entire wallet pipeline is
  // dormant on this deploy.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { ok: true };
  }

  await ensureFreeTierAccountReady(accountId);

  const account = await getCreditAccount(accountId);
  const snapshot = billingSnapshotFromAccount(account);
  const state = resolveBillingState(snapshot);
  const balance = snapshot.balance;
  const billingModel: BillingModel = isPerSeatAccount(snapshot.billingModel)
    ? 'per_seat'
    : 'legacy';

  if (!billingStateAllowsRun(state)) return blockedResult(state, snapshot, billingModel);

  // EVERY account now reaches the admission hold below. There used to be a
  // `subscriptionBypassesWalletFloor(snapshot)` early return here that let a
  // paying per-seat / credit-plan / paid-tier account through with no hold and
  // no floor. See the NO ACCOUNT BYPASSES THE WALLET FLOOR note in
  // billing-state.ts for what that cost ($588.81 spent against a $150 seat
  // grant on a $0 wallet, with the ledger silently frozen).
  //
  // Consequence to keep in mind when reading the rest of this function: the
  // hold is now the ONLY admission decision, so a drained paying account 402s
  // here exactly like a drained free one. `blockedResult` is what keeps them
  // distinguishable to the user — a paying account resolves `out_of_credits`
  // ("Top up"), never `no_subscription` ("Subscribe").

  // Wallet path: this used to be a read-only `balance >= floor` check,
  // fully decoupled from the real per-request deduction that only happens
  // once the whole (possibly long-running, streaming) request settles —
  // BILLING-CORRECTNESS finding: N concurrent requests could all read the
  // same pre-spend balance, all pass, and all get admitted before any of
  // them deducted anything. Converting the check into an ATOMIC hold closes
  // that admission race: this call itself deducts MINIMUM_CREDIT_FOR_RUN via
  // the same row-locked `atomic_use_credits` DB function the real deduction
  // uses, so concurrent admits genuinely serialize against the true current
  // balance instead of a stale SELECT. The hold is reconciled to the actual
  // cost at settle (recordGatewayUsage tops up the remainder or refunds the
  // unused portion) — see hooks.ts.
  //
  // Honest limitation: the hold amount is intentionally the existing (tiny,
  // 1-cent) admission floor, not a real estimate of the turn's eventual
  // cost — raising it would change product behavior for low-balance accounts
  // in a way out of scope here. That means the atomicity guarantee this
  // closes is "N concurrent requests can't all be admitted against a balance
  // that can't even cover N × 1 cent", not "an account can never end up
  // owing more than it had" — an expensive individual turn can still exceed
  // a thin balance before the top-up deduction at settle (that deduction
  // itself is still atomic and will never take the balance negative; the
  // residual exposure is Kortix failing to collect the marginal amount, not
  // an overdrawn account). See RELIABILITY-BACKLOG item 2 / PR description
  // for the full reservation system this is a pragmatic slice of.
  try {
    await deductCredits(
      accountId,
      MINIMUM_CREDIT_FOR_RUN,
      'LLM gateway admission hold',
      'llm_debit',
    );
    return { ok: true, holdUsd: MINIMUM_CREDIT_FOR_RUN };
  } catch {
    // The hold lost the race (or the wallet moved under us). Re-resolve against
    // an empty wallet so the blocked result carries the same discrimination the
    // pre-check would have produced.
    return blockedResult(
      resolveBillingState({ ...snapshot, balance: 0 }),
      { ...snapshot, balance },
      billingModel,
    );
  }
}

/**
 * Map a blocking `BillingState` onto the legacy 402 shape.
 *
 * `reason` is the WIRE-COMPATIBLE error code and is deliberately lossy — it
 * preserves exactly the codes clients have keyed off since PR #5141 (a
 * never-subscribed per-seat account is the only case that yields
 * `subscription_required`; every drained wallet, free or paying, yields
 * `insufficient_credits`). The real discrimination travels in `billingState`.
 */
function blockedResult(
  state: BillingState,
  snapshot: BillingSnapshot,
  billingModel: BillingModel,
): BillingGateBlocked {
  const hasSubscription = hasSubscriptionRecord(snapshot);
  const base = {
    ok: false as const,
    balance: snapshot.balance,
    billingModel,
    hasSubscription,
    billingState: state,
  };

  if (state === 'no_account') {
    return {
      ...base,
      reason: 'no_account',
      message: 'No credit account found. Complete account setup first.',
    };
  }

  if (state === 'payment_failed') {
    return {
      ...base,
      reason: 'insufficient_credits',
      message:
        "Your last payment didn't go through and your wallet is empty. Update your payment method or top up to keep running.",
    };
  }

  if (state === 'out_of_credits') {
    return {
      ...base,
      reason: 'insufficient_credits',
      message:
        billingModel === 'per_seat'
          ? 'Your team wallet is out of credits. Top up to keep your agents running.'
          : 'Out of credits. Top up to continue.',
    };
  }

  // no_subscription. Per-seat accounts get the seat pitch and the historical
  // `subscription_required` code; legacy/free accounts keep
  // `insufficient_credits` (their $2 grant ran out), which the client renders
  // as the plan pitch off `billing_state`, not off this code.
  return billingModel === 'per_seat'
    ? {
        ...base,
        reason: 'subscription_required',
        message:
          'Subscribe to activate your seat. $40/teammate per month includes wallet credits for compute and LLM usage.',
      }
    : {
        ...base,
        reason: 'insufficient_credits',
        message: 'Out of credits. Top up to continue.',
      };
}

export async function assertBillingActive(accountId: string): Promise<BillingGateOk> {
  const result = await checkBillingActive(accountId);
  if (result.ok) return result;
  throw new BillingGateError(result.reason, result.balance, result.message, accountId, {
    billingModel: result.billingModel,
    hasSubscription: result.hasSubscription,
    billingState: result.billingState,
  });
}
