'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AuthCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    console.log('🔄 [Auth Callback] Callback page loaded');
    console.log(
      '🔄 [Auth Callback] Search params:',
      Object.fromEntries(searchParams.entries()),
    );

    // Check for errors in the callback
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (error) {
      console.error('❌ [Auth Callback] OAuth error:', {
        error,
        errorDescription,
      });
      // Redirect to auth page with error
      router.push(`/auth?error=${encodeURIComponent(error)}`);
      return;
    }

    // The Amplify library handles the OAuth callback automatically
    // via the configured redirectSignIn URL. The tokens are stored in cookies.
    // We just need to redirect to the dashboard after a brief moment
    // to allow Amplify to complete its processing.
    console.log('✅ [Auth Callback] OAuth callback received, processing...');
    console.log('🔄 [Auth Callback] Waiting for Amplify to process tokens...');

    const timer = setTimeout(() => {
      console.log('✅ [Auth Callback] Redirecting to dashboard');
      router.push('/dashboard');
    }, 1000);

    return () => clearTimeout(timer);
  }, [router, searchParams]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="mb-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 dark:border-gray-100 mx-auto"></div>
        </div>
        <h2 className="text-2xl font-semibold mb-4">Authenticating...</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Please wait while we sign you in.
        </p>
      </div>
    </div>
  );
}
