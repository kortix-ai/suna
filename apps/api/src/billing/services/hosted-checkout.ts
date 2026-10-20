import type Stripe from "stripe";

export function createHostedCheckout(
  stripe: Stripe,
  params: Stripe.Checkout.SessionCreateParams,
) {
  // Only the server knows the account chosen by an unscoped checkout. Carry
  // that same resolved identity back to Billing, not the browser's selection.
  const accountId = params.metadata?.account_id;
  const successUrl =
    params.success_url && accountId ? new URL(params.success_url) : null;
  if (successUrl && typeof accountId === "string") {
    successUrl.searchParams.set("accountId", accountId);
    successUrl.searchParams.set("accountTab", "billing");
  }
  // Link display control was added in Basil; keep other requests on their existing version.
  const checkoutParams = {
    ...params,
    ...(successUrl ? { success_url: successUrl.toString() } : {}),
    wallet_options: { link: { display: "never" } },
  };
  return stripe.checkout.sessions.create(checkoutParams, {
    apiVersion: "2025-04-30.basil",
  });
}
