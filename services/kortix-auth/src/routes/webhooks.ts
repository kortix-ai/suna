import { Hono } from 'hono';
import { config } from '../config';

const webhooksRouter = new Hono();

/**
 * POST /v1/webhooks/stripe - Handle Stripe webhooks
 *
 * This is a placeholder. Full implementation should:
 * 1. Verify Stripe signature
 * 2. Handle subscription events (created, updated, cancelled)
 * 3. Handle invoice events (payment succeeded/failed)
 * 4. Grant/revoke credits based on subscription status
 */
webhooksRouter.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');

  if (!signature) {
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }

  if (!config.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook not configured' }, 500);
  }

  try {
    // Get raw body for signature verification
    const rawBody = await c.req.text();

    // TODO: Implement Stripe webhook handling
    // 1. Verify signature with Stripe SDK
    // 2. Parse event type
    // 3. Handle:
    //    - customer.subscription.created
    //    - customer.subscription.updated
    //    - customer.subscription.deleted
    //    - invoice.payment_succeeded
    //    - invoice.payment_failed

    console.log('[WEBHOOK] Received Stripe webhook (handler not fully implemented)');

    return c.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

export { webhooksRouter };
