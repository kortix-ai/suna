'use client';

import { Button } from '@/components/ui/button';
import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';

export default function Error({
  error,
}: {
  error: Error & { digest?: string; statusCode?: number };
}) {
  const handleReset = () => {
    try {
      window.location.reload();
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    console.error('[Kortix Home Error]', error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="flex max-w-xl flex-col items-center justify-center space-y-6 text-center">
        <KortixHyperLogo size={50} />

        <div className="space-y-4">
          <h1 className="text-base-900 text-base sm:text-lg md:text-xl">Something went wrong</h1>

          {error.message && <p className="text-base-500 text-base text-balance">{error.message}</p>}
        </div>

        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <Link href="/">Home</Link>
          </Button>
          <Button onClick={handleReset} size="sm" variant="secondary">
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
