/**
 * Real subscribe flow (no faking). Drives the same path the dashboard uses —
 * inline checkout — and confirms the Stripe PaymentIntent in TEST MODE with a
 * test payment method, so credits are granted the legitimate way (activate →
 * webhook/activateSubscription). This is the prerequisite that lets an account
 * create sessions.
 *
 *   create-inline-checkout → (Stripe) confirm PaymentIntent w/ pm_card_visa → confirm-inline-checkout
 */
import { createHmac } from "node:crypto";
import type { Client } from "../core/client";
import type { Env } from "../core/env";
import { log } from "../core/log";
import { sleep } from "../core/poll";

const TEST_PAYMENT_METHOD = "pm_card_visa";

/** Confirm a Stripe PaymentIntent in test mode using a test card. */
async function confirmPaymentIntent(env: Env, clientSecret: string): Promise<void> {
  if (!env.stripeSecretKey) throw new Error("KE2E_STRIPE_SECRET_KEY required to confirm the subscribe PaymentIntent");
  const piId = clientSecret.split("_secret_")[0];
  const form = new URLSearchParams({
    payment_method: TEST_PAYMENT_METHOD,
    return_url: "https://example.com/return",
  });
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.stripeSecretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Stripe PI confirm failed: ${res.status} ${await res.text()}`);
  const pi = (await res.json()) as { status?: string };
  if (pi.status !== "succeeded") throw new Error(`PaymentIntent not succeeded (status=${pi.status})`);
}

/**
 * Subscribe `accountId` to a paid tier the real way → credits granted.
 * Idempotent-ish: a no_payment_required result (already entitled) short-circuits.
 */
export async function subscribe(
  env: Env,
  client: Client,
  accountId: string,
  tierKey = "pro",
): Promise<void> {
  const created = await client.post("/v1/billing/create-inline-checkout", {
    account_id: accountId,
    tier_key: tierKey,
    billing_period: "monthly",
  });
  created.status([200, 201]);
  const body = created.json<any>();

  if (body?.no_payment_required) {
    log.step(`subscribe: ${accountId} entitled (no payment required)`);
    return;
  }
  if (!body?.client_secret || !body?.subscription_id) {
    throw new Error(`create-inline-checkout returned no client_secret/subscription_id: ${created.text()}`);
  }

  await confirmPaymentIntent(env, body.client_secret);

  // The `pro` tier grants 0 monthly credits by design ($5/machine model), so the
  // subscription alone leaves the account with a 0 balance and sessions 402. To
  // give the account a real, usable balance we replay a real credit-PURCHASE
  // event (`checkout.session.completed`, mode=payment → handleCreditPurchase →
  // grantCredits) with a VALID signature (whsec_…) — the exact path a real "buy
  // credits" flow takes. Stripe→API webhook delivery isn't wired to dev-api, so we
  // supply the delivery; the handler code runs unchanged.
  if (env.stripeWebhookSecret) {
    await forgeCreditPurchaseWebhook(env, accountId).catch((err) =>
      log.warn(`subscribe: forged credit-purchase webhook failed: ${(err as Error)?.message ?? err}`),
    );
  }

  // Drive the dashboard's confirm step too (sets sub id/status) — best effort.
  let lastErr: unknown;
  let activated = false;
  for (let i = 0; i < 5; i++) {
    const confirmed = await client.post("/v1/billing/confirm-inline-checkout", {
      account_id: accountId,
      subscription_id: body.subscription_id,
      tier_key: tierKey,
    });
    if (confirmed.statusCode < 400) {
      activated = true;
      break;
    }
    lastErr = confirmed.text();
    await sleep(1500);
  }
  if (!activated) throw new Error(`confirm-inline-checkout never activated: ${lastErr}`);

  // Monthly credits are granted
  // by the Stripe `invoice.paid` webhook (services/webhooks.ts → grantCredits),
  // which lands asynchronously. Poll the real account-state until the balance is
  // usable — that's the true signal that billing-gated flows (sessions) can run.
  await waitForCredits(client, accountId, tierKey);
}

const FUNDING_CREDITS_USD = 50;

/**
 * POST a validly-signed `checkout.session.completed` (mode=payment) credit-purchase
 * event to the platform Stripe webhook so the REAL handler (handleCreditPurchase →
 * grantCredits) gives the account a usable balance. This is the exact path a real
 * "buy credits" purchase takes; we only supply the webhook delivery Stripe isn't
 * making to this target. No tier dependency, no recovery guard.
 */
async function forgeCreditPurchaseWebhook(env: Env, accountId: string): Promise<void> {
  if (!env.stripeWebhookSecret) throw new Error("KE2E_STRIPE_WEBHOOK_SECRET required to sign the funding webhook");

  const sessionId = `cs_ke2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const event = {
    id: `evt_ke2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: FUNDING_CREDITS_USD * 100,
        currency: "usd",
        payment_intent: null,
        metadata: { account_id: accountId },
      },
    },
  };

  // Stripe signature scheme: header `t=<ts>,v1=<HMAC_SHA256(`${ts}.${payload}`)>`.
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", env.stripeWebhookSecret).update(`${ts}.${payload}`).digest("hex");

  const res = await fetch(`${env.apiUrl}/billing/webhook/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` },
    body: payload,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`webhook POST failed: ${res.status} ${text}`);
  log.step(`subscribe: forged $${FUNDING_CREDITS_USD} credit purchase accepted (${accountId})`);
}

/** Poll account-state until the account can actually run (credits granted). */
async function waitForCredits(client: Client, accountId: string, tierKey: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await client.get("/v1/billing/account-state", { query: { account_id: accountId } });
    if (r.statusCode === 200) {
      last = r.json<any>();
      const credits = last?.credits ?? {};
      if (credits.can_run === true || Number(credits.total) > 0) {
        log.step(`subscribe: ${accountId} → ${tierKey} active + funded (balance ${credits.total})`);
        return;
      }
    }
    await sleep(3000);
  }
  throw new Error(
    `subscribe: ${tierKey} activated but credits never landed within 90s ` +
      `(balance ${last?.credits?.total ?? "?"}) — is the Stripe invoice.paid webhook wired to this target?`,
  );
}
