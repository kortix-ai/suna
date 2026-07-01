import Stripe from 'stripe';
import { sharedConfig as config } from './effect';

let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    if (!config.STRIPE_SECRET_KEY) {
      throw new Error('Missing STRIPE_SECRET_KEY');
    }

    client = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  }

  return client;
}
