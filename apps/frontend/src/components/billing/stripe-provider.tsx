'use client';

import { loadStripe, Stripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { ReactNode, useMemo } from 'react';

const getStripeKey = () => {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    console.error('[StripeProvider] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set');
  }
  return key || '';
};

let stripePromise: Promise<Stripe | null> | null = null;

const getStripe = () => {
  if (!stripePromise) {
    stripePromise = loadStripe(getStripeKey());
  }
  return stripePromise;
};

interface StripeProviderProps {
  children: ReactNode;
  clientSecret?: string;
}

export function StripeProvider({ children, clientSecret }: StripeProviderProps) {
  const stripe = useMemo(() => getStripe(), []);

  const options = clientSecret
    ? {
        clientSecret,
        appearance: {
          theme: 'stripe' as const,
          variables: {
            borderRadius: '8px',
            colorPrimary: '#6366f1',
          },
        },
      }
    : undefined;

  return (
    <Elements stripe={stripe} options={options}>
      {children}
    </Elements>
  );
}
