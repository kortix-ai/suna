import { expect, test } from 'bun:test';
import Stripe from 'stripe';
import { createHostedCheckout } from './hosted-checkout';

test.each(['payment', 'subscription'] as const)('hosted %s checkout disables Link without restricting other methods', async (mode) => {
  const requests: Array<{ body: string; version: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({ body: await request.text(), version: request.headers.get('stripe-version') });
      return Response.json({ id: 'cs_test_synthetic', url: 'https://example.test/checkout' });
    },
  });
  try {
    const stripe = new Stripe('sk_test_synthetic', {
      apiVersion: '2023-10-16', host: '127.0.0.1', port: server.port, protocol: 'http',
    });
    const result = await createHostedCheckout(stripe, {
      mode, line_items: [{ price: 'price_synthetic', quantity: 2 }],
      success_url: 'https://example.test/success', cancel_url: 'https://example.test/cancel',
      metadata: { purpose: 'synthetic' },
    });
    expect(result.url).toBe('https://example.test/checkout');
    expect(requests).toHaveLength(1);
    const body = new URLSearchParams(requests[0].body);
    expect(body.get('wallet_options[link][display]')).toBe('never');
    expect(requests[0].version).toBe('2025-04-30.basil');
    expect(body.get('mode')).toBe(mode);
    expect(body.get('line_items[0][quantity]')).toBe('2');
    expect(body.get('metadata[purpose]')).toBe('synthetic');
    expect([...body.keys()].some((key) => key.startsWith('payment_method_types'))).toBe(false);
    await stripe.customers.retrieve('cus_synthetic');
    expect(requests[1].version).toBe('2023-10-16');
  } finally {
    server.stop(true);
  }
});


test("checkout return opens billing for the server-resolved account, not a stale selection", async () => {
  let successUrl = "";
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = new URLSearchParams(await request.text());
      successUrl = body.get("success_url") ?? "";
      return Response.json({
        id: "cs_test_synthetic",
        url: "https://example.test/checkout",
      });
    },
  });
  try {
    const stripe = new Stripe("sk_test_synthetic", {
      apiVersion: "2023-10-16",
      host: "127.0.0.1",
      port: server.port,
      protocol: "http",
    });
    await createHostedCheckout(stripe, {
      mode: "payment",
      success_url:
        "https://example.test/projects/start?credit_purchase=success&accountId=stale&accountTab=usage",
      metadata: { account_id: "synthetic-purchased-account" },
    });
    const url = new URL(successUrl);
    expect(url.origin).toBe("https://example.test");
    expect(url.pathname).toBe("/projects/start");
    expect(url.searchParams.get("credit_purchase")).toBe("success");
    expect(url.searchParams.get("accountId")).toBe(
      "synthetic-purchased-account",
    );
    expect(url.searchParams.get("accountTab")).toBe("billing");
  } finally {
    server.stop(true);
  }
});
