'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import Script from 'next/script';

function CheckoutContent() {
  const searchParams = useSearchParams();
  const clientSecret = searchParams.get('client_secret');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stripeLoaded, setStripeLoaded] = useState(false);

  // Check if Stripe is already loaded
  useEffect(() => {
    const checkStripe = () => {
      if (typeof window !== 'undefined' && typeof window.Stripe !== 'undefined') {
        console.log('✅ Stripe already loaded on window!');
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
        console.error('❌ Stripe still not loaded after 5 seconds');
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
    console.log('🔍 Effect running - clientSecret:', clientSecret ? 'YES' : 'NO', 'stripeLoaded:', stripeLoaded);
    
    if (!clientSecret) {
      console.error('❌ No client secret provided');
      setError('No checkout session provided. Please start the checkout process again.');
      setIsLoading(false);
      return;
    }

    if (!stripeLoaded) {
      console.log('⏳ Waiting for Stripe to load...');
      return; // Wait for Stripe to load
    }

    console.log('✅ Both client secret and Stripe are ready - initializing...');

    // Initialize Stripe checkout
    const initCheckout = async () => {
      try {
        const stripeKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || 
                         "pk_test_51R5BVvG6l1KZGqIrmU0aQRSS8Bgdp2ciuw0YyGhABeK7HgH2GxHvNy8d1inB2dU33lda2uj9JR4Ij46aFVbW8oge008y1RWpDB";
        
        console.log('🔄 Initializing Stripe checkout...');
        console.log('🔑 Stripe key:', stripeKey?.substring(0, 20) + '...');
        console.log('🎫 Client secret:', clientSecret.substring(0, 20) + '...');

        if (typeof window.Stripe === 'undefined') {
          throw new Error('Stripe not loaded on window');
        }

        const stripe = window.Stripe(stripeKey);
        console.log('✅ Stripe instance created');
        
        // Initialize embedded checkout
        console.log('🚀 Calling initEmbeddedCheckout...');
        const checkout = await stripe.initEmbeddedCheckout({
          clientSecret: clientSecret,
        });
        console.log('✅ Embedded checkout created');

        // Stop loading FIRST so the container renders
        console.log('📍 Rendering checkout container...');
        setIsLoading(false);
        
        // Wait for DOM to update, then mount
        setTimeout(() => {
          const container = document.getElementById('checkout-container');
          console.log('🔍 Container exists?', container ? 'YES' : 'NO');
          
          if (!container) {
            throw new Error('Checkout container not found in DOM');
          }
          
          console.log('📍 Mounting to #checkout-container...');
          checkout.mount('#checkout-container');
          console.log('✅ Checkout mounted successfully!');
        }, 100);
      } catch (err: any) {
        console.error('❌ Checkout error:', err);
        console.error('❌ Error details:', err.message, err.stack);
        setError(err.message || 'Failed to load checkout. Please try again.');
        setIsLoading(false);
      }
    };

    initCheckout();
  }, [clientSecret, stripeLoaded]);

  return (
    <>
      <Script 
        src="https://js.stripe.com/v3/" 
        onLoad={() => {
          console.log('✅ Stripe.js loaded!');
          setStripeLoaded(true);
        }}
        onError={(e) => {
          console.error('❌ Stripe.js failed to load:', e);
          setError('Failed to load payment system');
          setIsLoading(false);
        }}
        onReady={() => {
          console.log('✅ Stripe.js ready!');
          setStripeLoaded(true);
        }}
      />
      
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        {error ? (
          <Card className="w-full max-w-md bg-white">
            <CardHeader className="text-center">
              <CardTitle className="text-gray-900">Checkout Error</CardTitle>
              <CardDescription className="text-gray-600">Unable to load checkout</CardDescription>
            </CardHeader>
            <CardContent>
              <Alert variant="destructive">
                <AlertDescription className="text-center">
                  {error}
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <div className="flex flex-col items-center gap-4">
            <KortixLoader size="xlarge" />
            <p className="text-gray-600 text-sm">Loading secure checkout...</p>
          </div>
        ) : (
          // Embedded checkout container
          <div className="w-full max-w-4xl">
            <div id="checkout-container"></div>
          </div>
        )}
      </div>
    </>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-white flex items-center justify-center">
        <KortixLoader size="large" forceTheme="light" />
      </div>
    }>
      <CheckoutContent />
    </Suspense>
  );
}

