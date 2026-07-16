import { HTTPException } from "hono/http-exception";
import { config } from "../../config";
import { getCreditAccount } from "../repositories/credit-accounts";
import { ensureFreeTierAccountReady } from "./free-tier";
import { isPerSeatAccount, MINIMUM_CREDIT_FOR_RUN } from "./tiers";

type BillingGateReason =
  | "subscription_required"
  | "insufficient_credits"
  | "no_account";

export interface BillingGateOk {
  ok: true;
}

export interface BillingGateBlocked {
  ok: false;
  reason: BillingGateReason;
  balance: number;
  message: string;
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
  constructor(readonly reason: BillingGateReason, readonly balance: number, message: string, accountId: string) {
    super(402, {
      message,
      res: new Response(
        JSON.stringify({
          error: message,
          code: reason,
          balance,
          // The blocked account — so the upgrade dialog scopes to it instead of
          // the caller's primary account (see web error-handler → openUpgradeDialog).
          account_id: accountId,
        }),
        { status: 402, headers: { "content-type": "application/json" } },
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
      reason: "no_account",
      balance: 0,
      message: "No credit account found. Complete account setup first.",
    };
  }

  const balance = Number(account.balance ?? 0);
  const hasActiveSub =
    !!account.stripeSubscriptionId &&
    account.stripeSubscriptionStatus !== "canceled" &&
    account.stripeSubscriptionStatus !== "unpaid";

  if (isPerSeatAccount(account.billingModel)) {
    if (hasActiveSub) return { ok: true };
    if (balance >= MINIMUM_CREDIT_FOR_RUN) return { ok: true };
    return {
      ok: false,
      reason: "subscription_required",
      balance,
      message:
        "Subscribe to activate your seat. $20/teammate per month includes wallet credits for compute and LLM usage.",
    };
  }

  if (balance >= MINIMUM_CREDIT_FOR_RUN) return { ok: true };
  return {
    ok: false,
    reason: "insufficient_credits",
    balance,
    message: "Out of credits. Top up to continue.",
  };
}

export async function assertBillingActive(accountId: string): Promise<void> {
  const result = await checkBillingActive(accountId);
  if (result.ok) return;
  throw new BillingGateError(result.reason, result.balance, result.message, accountId);
}
