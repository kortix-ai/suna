import { describe, expect, test } from 'bun:test';

import { confirmPendingPlanPayment } from './confirm-plan-payment';

const stripeAnswering = (answer: { paymentIntent?: { status: string }; error?: { message?: string } }) => {
  const secrets: string[] = [];
  return {
    secrets,
    loadStripe: async () => (_key: string) => ({
      confirmCardPayment: async (secret: string) => {
        secrets.push(secret);
        return answer;
      },
    }),
  };
};

describe('confirmPendingPlanPayment', () => {
  test('a confirmed raise needs no portal', async () => {
    const stripe = stripeAnswering({ paymentIntent: { status: 'succeeded' } });
    expect(await confirmPendingPlanPayment('pi_secret', { loadStripe: stripe.loadStripe, publishableKey: 'pk_test' })).toBe(
      'confirmed',
    );
    expect(stripe.secrets).toEqual(['pi_secret']);
  });

  test('a processing payment is reported as processing', async () => {
    const stripe = stripeAnswering({ paymentIntent: { status: 'processing' } });
    expect(await confirmPendingPlanPayment('pi_secret', { loadStripe: stripe.loadStripe, publishableKey: 'pk_test' })).toBe(
      'processing',
    );
  });

  test('a decline, no secret, no key, or no Stripe.js falls back to the portal', async () => {
    const declined = stripeAnswering({ error: { message: 'Your card was declined.' } });
    expect(await confirmPendingPlanPayment('pi_secret', { loadStripe: declined.loadStripe, publishableKey: 'pk_test' })).toBe(
      'needs-portal',
    );
    expect(await confirmPendingPlanPayment(null, { loadStripe: declined.loadStripe, publishableKey: 'pk_test' })).toBe(
      'needs-portal',
    );
    expect(await confirmPendingPlanPayment('pi_secret', { loadStripe: declined.loadStripe, publishableKey: '' })).toBe(
      'needs-portal',
    );
    expect(await confirmPendingPlanPayment('pi_secret', { loadStripe: async () => null, publishableKey: 'pk_test' })).toBe(
      'needs-portal',
    );
    expect(
      await confirmPendingPlanPayment('pi_secret', {
        loadStripe: async () => {
          throw new Error('blocked');
        },
        publishableKey: 'pk_test',
      }),
    ).toBe('needs-portal');
  });
});
