/**
 * Confirm a plan raise that Stripe left `payment_pending`.
 *
 * `POST /v1/billing/plan` answers `payment_pending` with the PaymentIntent
 * `client_secret` of the raise's invoice when the charge needs the payer
 * (3-D Secure, a bank challenge). Stripe.js `confirmCardPayment` runs that step
 * on the saved card. A decline, a missing secret, or Stripe.js that will not
 * load falls back to the billing portal, as before.
 */

interface StripePaymentConfirmer {
  confirmCardPayment: (
    clientSecret: string,
  ) => Promise<{ paymentIntent?: { status: string }; error?: { message?: string } }>;
}

type StripeFactory = (publishableKey: string) => StripePaymentConfirmer;

export type PendingPaymentOutcome = 'confirmed' | 'processing' | 'needs-portal';

export async function confirmPendingPlanPayment(
  clientSecret: string | null | undefined,
  deps: {
    loadStripe: () => Promise<StripeFactory | null>;
    publishableKey: string;
  },
): Promise<PendingPaymentOutcome> {
  if (!clientSecret || !deps.publishableKey) return 'needs-portal';
  let factory: StripeFactory | null = null;
  try {
    factory = await deps.loadStripe();
  } catch {
    return 'needs-portal';
  }
  if (!factory) return 'needs-portal';
  try {
    const result = await factory(deps.publishableKey).confirmCardPayment(clientSecret);
    if (result.error || !result.paymentIntent) return 'needs-portal';
    if (result.paymentIntent.status === 'succeeded') return 'confirmed';
    if (result.paymentIntent.status === 'processing') return 'processing';
    return 'needs-portal';
  } catch {
    return 'needs-portal';
  }
}

const STRIPE_JS_URL = 'https://js.stripe.com/v3/';
const STRIPE_JS_TIMEOUT_MS = 10_000;

/** Stripe.js from js.stripe.com (the same script the checkout page loads). */
export function loadStripeJs(): Promise<StripeFactory | null> {
  const read = () => (window as unknown as { Stripe?: StripeFactory }).Stripe ?? null;
  const loaded = read();
  if (loaded) return Promise.resolve(loaded);
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS_URL}"]`);
    const script = existing ?? Object.assign(document.createElement('script'), { src: STRIPE_JS_URL, async: true });
    const timer = window.setTimeout(() => resolve(read()), STRIPE_JS_TIMEOUT_MS);
    script.addEventListener('load', () => {
      window.clearTimeout(timer);
      resolve(read());
    });
    script.addEventListener('error', () => {
      window.clearTimeout(timer);
      resolve(null);
    });
    if (!existing) document.head.appendChild(script);
  });
}
