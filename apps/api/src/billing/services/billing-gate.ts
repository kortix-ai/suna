import { HTTPException } from 'hono/http-exception';
import { config } from '../../config';
import { getCreditAccount } from '../repositories/credit-accounts';
import { deductCredits } from './credits';
import { ensureFreeTierAccountReady } from './free-tier';
import { type BillingModel, MINIMUM_CREDIT_FOR_RUN, isPerSeatAccount } from './tiers';

type BillingGateReason = 'subscription_required' | 'insufficient_credits' | 'no_account';

export interface BillingGateOk {
  ok: true;
  // Set only on the pure-wallet (non-per-seat-active-sub, non-self-host)
  // path, where this call ATOMICALLY reserved (deducted) this many dollars
  // from the account as an admission hold — see the comment below. The
  // caller (llm-gateway hooks) reconciles it against the real cost at
  // settle time (recordGatewayUsage) instead of a flat post-hoc deduct.
  // Absent when no hold was taken (billing disabled, or an active per-seat
  // subscription bypasses the wallet floor entirely).
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
    extra?: { billingModel?: BillingModel; hasSubscription?: boolean },
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
  if (!account) {
    return {
      ok: false,
      reason: 'no_account',
      balance: 0,
      message: 'No credit account found. Complete account setup first.',
      billingModel: 'legacy',
      hasSubscription: false,
    };
  }

  const balance = Number(account.balance ?? 0);
  const billingModel: BillingModel = isPerSeatAccount(account.billingModel) ? 'per_seat' : 'legacy';
  // Any subscription row at all — used to distinguish a paying-but-lapsed Team
  // account (top up) from one that never subscribed (subscribe to activate).
  const hasSubscription = !!account.stripeSubscriptionId;
  const hasActiveSub =
    hasSubscription &&
    account.stripeSubscriptionStatus !== 'canceled' &&
    account.stripeSubscriptionStatus !== 'unpaid';

  if (isPerSeatAccount(account.billingModel)) {
    // An active subscription isn't wallet-gated at all — no hold to take.
    if (hasActiveSub) return { ok: true };
    if (balance >= MINIMUM_CREDIT_FOR_RUN) return { ok: true };
    // A Team account that HAS a (now-lapsed) subscription and a drained wallet
    // isn't a "subscribe from Free" case — it's out of credits. Surface it as
    // insufficient_credits so the client shows top-up, not the Free-plan pitch.
    // Only a per-seat account that never subscribed gets the subscribe CTA.
    return hasSubscription
      ? {
          ok: false,
          reason: 'insufficient_credits',
          balance,
          message: 'Your team wallet is out of credits. Top up to keep your agents running.',
          billingModel,
          hasSubscription,
        }
      : {
          ok: false,
          reason: 'subscription_required',
          balance,
          message:
            'Subscribe to activate your seat. $40/teammate per month includes wallet credits for compute and LLM usage.',
          billingModel,
          hasSubscription,
        };
  }

  // Pure-wallet path: this used to be a read-only `balance >= floor` check,
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
    return {
      ok: false,
      reason: 'insufficient_credits',
      balance,
      message: 'Out of credits. Top up to continue.',
      billingModel,
      hasSubscription,
    };
  }
}

export async function assertBillingActive(accountId: string): Promise<BillingGateOk> {
  const result = await checkBillingActive(accountId);
  if (result.ok) return result;
  throw new BillingGateError(result.reason, result.balance, result.message, accountId, {
    billingModel: result.billingModel,
    hasSubscription: result.hasSubscription,
  });
}
