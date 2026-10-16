import type Stripe from 'stripe';

export function createHostedCheckout(stripe: Stripe, params: Stripe.Checkout.SessionCreateParams) {
  // Link display control was added in Basil. Keep other billing requests on
  // their existing API version; SDK 14 forwards this newer parameter unchanged.
  const checkoutParams = {
    ...params,
    wallet_options: { link: { display: 'never' } },
  };
  return stripe.checkout.sessions.create(checkoutParams, { apiVersion: '2025-04-30.basil' });
}
