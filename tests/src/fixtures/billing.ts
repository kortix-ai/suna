/**
 * Real subscribe flow (no faking). Drives the same path the dashboard uses —
 * inline checkout — and confirms the Stripe PaymentIntent in TEST MODE with a
 * test payment method, so credits are granted the legitimate way (activate →
 * webhook/activateSubscription). This is the prerequisite that lets an account
 * create sessions.
 *
 *   create-inline-checkout → (Stripe) confirm PaymentIntent w/ pm_card_visa → confirm-inline-checkout
 */
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
  const created = await client.post("/v1/billing/subscriptions/create-inline-checkout", {
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

  // Stripe flips the subscription to active right after confirm in test mode, but
  // allow a couple of retries for eventual consistency before activating credits.
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    const confirmed = await client.post("/v1/billing/subscriptions/confirm-inline-checkout", {
      account_id: accountId,
      subscription_id: body.subscription_id,
      tier_key: tierKey,
    });
    if (confirmed.statusCode < 400) {
      log.step(`subscribe: ${accountId} → ${tierKey} active`);
      return;
    }
    lastErr = confirmed.text();
    await sleep(1500);
  }
  throw new Error(`confirm-inline-checkout never activated: ${lastErr}`);
}
