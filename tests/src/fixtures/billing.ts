/**
 * Real subscribe flow (no faking). Puts an account on the credits plan through
 * Stripe TEST mode, the way a hosted Checkout would, minus the browser:
 *
 *   POST /v1/billing/plan            → our API creates + maps the Stripe customer
 *   (Stripe) attach pm_card_visa, create the subscription on the credits price
 *   POST /v1/billing/sync-subscription → our API adopts it and grants its credits
 *
 * The Stripe `invoice.paid` webhook converges on the same state where it is
 * wired; the sync call makes the fixture independent of webhook delivery.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { Client } from "../core/client";
import type { Env } from "../core/env";
import { log } from "../core/log";
import { sleep } from "../core/poll";
import { retryBootstrapCreate } from "./transient";

const TEST_PAYMENT_METHOD = "pm_card_visa";
const CREDITS_PRICE_LOOKUP_KEY = "kortix_credits_monthly";

async function stripe<T>(env: Env, method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
  if (!env.stripeSecretKey) throw new Error("KE2E_STRIPE_SECRET_KEY required to subscribe in Stripe test mode");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.stripeSecretKey}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stripe ${method} ${path} failed: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Subscribe `accountId` to the credits plan at `monthlyUsd` a month, the real
 * way → credits granted.
 */
export async function subscribe(
  env: Env,
  client: Client,
  accountId: string,
  monthlyUsd = 50,
): Promise<void> {
  // Bootstrap-time create: retried through a transient edge-laundered 5xx — an
  // abandoned Checkout session is inert. See fixtures/transient.ts.
  const created = await retryBootstrapCreate("plan checkout create", async () => {
    const res = await client.post("/v1/billing/plan", {
      account_id: accountId,
      monthly_usd: monthlyUsd,
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/cancel",
    });
    res.status([200, 201]);
    return res;
  });
  const body = created.json<{ status: string; checkout_url?: string }>();
  if (body.status !== "checkout_created") {
    log.step(`subscribe: ${accountId} already on a credits plan (${body.status})`);
    await waitForCredits(client, accountId, monthlyUsd);
    return;
  }

  const sessionId = body.checkout_url?.match(/cs_(test|live)_[A-Za-z0-9]+/)?.[0];
  if (!sessionId) throw new Error(`POST /billing/plan returned no Checkout session: ${created.text()}`);
  const session = await stripe<{ customer: string }>(env, "GET", `/checkout/sessions/${sessionId}`);
  const prices = await stripe<{ data: Array<{ id: string }> }>(
    env,
    "GET",
    `/prices?lookup_keys[]=${CREDITS_PRICE_LOOKUP_KEY}`,
  );
  const priceId = prices.data[0]?.id;
  if (!priceId) throw new Error(`no Stripe price with lookup_key ${CREDITS_PRICE_LOOKUP_KEY} in this test account`);

  const pm = await stripe<{ id: string }>(env, "POST", `/payment_methods/${TEST_PAYMENT_METHOD}/attach`, {
    customer: session.customer,
  });
  const sub = await stripe<{ id: string; status: string }>(env, "POST", "/subscriptions", {
    customer: session.customer,
    default_payment_method: pm.id,
    "items[0][price]": priceId,
    "items[0][quantity]": String(monthlyUsd * 100),
    "metadata[account_id]": accountId,
    "metadata[plan_key]": "credits",
    "metadata[tier_key]": "credits",
  });
  if (sub.status !== "active") throw new Error(`test subscription ${sub.id} is ${sub.status}, not active`);

  // Stripe→API webhook delivery is not wired to every target; fund a usable
  // balance through the real credit-purchase handler with a signed event.
  if (env.stripeWebhookSecret) {
    await forgeCreditPurchaseWebhook(env, accountId).catch((err) =>
      log.warn(`subscribe: forged credit-purchase webhook failed: ${(err as Error)?.message ?? err}`),
    );
  }

  let lastErr: unknown;
  let synced = false;
  for (let i = 0; i < 5; i++) {
    const r = await client.post("/v1/billing/sync-subscription", { account_id: accountId });
    if (r.statusCode < 400) {
      synced = true;
      break;
    }
    lastErr = r.text();
    await sleep(1500);
  }
  if (!synced) throw new Error(`sync-subscription never adopted ${sub.id}: ${lastErr}`);

  await waitForCredits(client, accountId, monthlyUsd);
}

const FUNDING_CREDITS_USD = 50;

/**
 * POST a validly-signed `checkout.session.completed` (mode=payment) credit-purchase
 * event to the platform Stripe webhook so the REAL handler (handleCreditPurchase →
 * wallet.grant) gives the account a usable balance. This is the exact path a real
 * "buy credits" purchase takes; we only supply the webhook delivery Stripe isn't
 * making to this target. No tier dependency, no recovery guard.
 */
async function forgeCreditPurchaseWebhook(env: Env, accountId: string): Promise<void> {
  if (!env.stripeWebhookSecret) throw new Error("KE2E_STRIPE_WEBHOOK_SECRET required to sign the funding webhook");

  const sessionId = `cs_ke2e_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const event = {
    id: `evt_ke2e_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 6)}`,
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
async function waitForCredits(client: Client, accountId: string, monthlyUsd: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await client.get("/v1/billing/account-state", { query: { account_id: accountId } });
    if (r.statusCode === 200) {
      last = r.json<any>();
      const credits = last?.credits ?? {};
      if (credits.can_run === true || Number(credits.total) > 0) {
        log.step(`subscribe: ${accountId} → credits $${monthlyUsd}/mo active + funded (balance ${credits.total})`);
        return;
      }
    }
    await sleep(3000);
  }
  throw new Error(
    `subscribe: credits plan activated but credits never landed within 90s ` +
      `(balance ${last?.credits?.total ?? "?"}) — is the Stripe invoice.paid webhook wired to this target?`,
  );
}
