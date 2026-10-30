'use client';

import { useTranslations } from '@/i18n/use-translations';

import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { OutcomeTitle } from '@kortix/ui/internal/auth/auth-consent';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { Suspense, useEffect, useState } from 'react';

/** The slice of Stripe.js (loaded from js.stripe.com below) this page calls.
 *  `window.Stripe` used to type-check only because `@next/third-parties`
 *  widened `Window` with an `any` index signature; the root layout no longer
 *  imports that package. */
declare global {
  interface Window {
    Stripe?: (publishableKey: string) => {
      initEmbeddedCheckout: (options: { clientSecret: string }) => Promise<{
        mount: (selector: string) => void;
      }>;
    };
  }
}

function CheckoutContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const searchParams = useSearchParams();
  const clientSecret = searchParams.get('client_secret');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stripeLoaded, setStripeLoaded] = useState(false);

  // Check if Stripe is already loaded
  useEffect(() => {
    const checkStripe = () => {
      if (typeof window !== 'undefined' && typeof window.Stripe !== 'undefined') {
        setStripeLoaded(true);
        return true;
      }
      return false;
    };

    // Check immediately
    if (checkStripe()) return;

    // Keep checking for 5 seconds
    const interval = setInterval(() => {
      if (checkStripe()) {
        clearInterval(interval);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      if (typeof window.Stripe === 'undefined') {
        console.error('Stripe.js did not load within 5s');
        setError('Payment system taking too long to load. Please refresh the page.');
        setIsLoading(false);
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!clientSecret) {
      setError('No checkout session provided. Please start the checkout process again.');
      setIsLoading(false);
      return;
    }

    if (!stripeLoaded) {
      return; // Wait for Stripe to load
    }

    let disposed = false;
    let mountTimer: ReturnType<typeof setTimeout> | null = null;

    // Initialize Stripe checkout
    const initCheckout = async () => {
      try {
        const stripeKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';

        if (typeof window.Stripe === 'undefined') {
          throw new Error('Stripe not loaded on window');
        }

        const stripe = window.Stripe(stripeKey);

        // Initialize embedded checkout
        const checkout = await stripe.initEmbeddedCheckout({
          clientSecret: clientSecret,
        });

        if (disposed) return;

        // Stop loading FIRST so the container renders
        setIsLoading(false);

        // Wait for DOM to update, then mount
        mountTimer = setTimeout(() => {
          if (disposed) return;
          const container = document.getElementById('checkout-container');

          if (!container) {
            throw new Error('Checkout container not found in DOM');
          }

          checkout.mount('#checkout-container');
        }, 100);
      } catch (err: any) {
        if (disposed) return;
        console.error('Checkout initialization failed:', err);
        setError(err.message || 'Failed to load checkout. Please try again.');
        setIsLoading(false);
      }
    };

    initCheckout();

    return () => {
      disposed = true;
      if (mountTimer) clearTimeout(mountTimer);
    };
  }, [clientSecret, stripeLoaded]);

  return (
    <>
      <Script
        src="https://js.stripe.com/v3/"
        onLoad={() => {
          setStripeLoaded(true);
        }}
        onError={(e) => {
          console.error(tHardcodedUi.raw('i18nComplete.text44b63a4c6f6b'), e);
          setError(tHardcodedUi.raw('i18nComplete.text517a26051a61'));
          setIsLoading(false);
        }}
        onReady={() => {
          setStripeLoaded(true);
        }}
      />

      {error ? (
        <AuthFrame footerVariant="none">
          <Rise>
            <StepHeader
              title={
                <OutcomeTitle tone="destructive">
                  {tHardcodedUi.raw('appCheckoutPage.line145JsxTextUnableToLoadCheckout')}
                </OutcomeTitle>
              }
              description={error}
            />
          </Rise>
          <Rise delay={0.06}>
            <Button size="lg" variant="secondary" className="w-full" asChild>
              <Link href="/">{tHardcodedUi.raw('i18nComplete.text5fae82827f98')}</Link>
            </Button>
          </Rise>
        </AuthFrame>
      ) : isLoading ? (
        <CheckoutPending
          label={tHardcodedUi.raw('appCheckoutPage.line158JsxTextLoadingSecureCheckout')}
        />
      ) : (
        // Embedded checkout container
        <div className="bg-background flex min-h-svh justify-center px-4 py-10">
          <div id="checkout-container" className="w-full max-w-4xl" />
        </div>
      )}
    </>
  );
}

/** The quiet auth frame with the app's one spinner, while Stripe.js mounts. */
function CheckoutPending({ label }: { label?: string }) {
  return (
    <AuthFrame footerVariant="none">
      <div
        role="status"
        className="text-muted-foreground flex items-center justify-center gap-2 text-sm"
      >
        <Loading className="size-4 shrink-0" />
        {label}
      </div>
    </AuthFrame>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<CheckoutPending />}>
      <CheckoutContent />
    </Suspense>
  );
}
