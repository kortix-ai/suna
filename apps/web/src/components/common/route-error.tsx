'use client';

import { Button } from '@/components/ui/button';
import * as Sentry from '@sentry/nextjs';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { ErrorDetails } from './error-details';

/**
 * Shared fallback for Next.js route-segment `error.tsx` boundaries. Reports the
 * error to Sentry and offers recovery (segment-local `reset()` or full reload),
 * keeping the surrounding layout/nav intact instead of blanking the whole app.
 */
export function RouteErrorFallback({
  error,
  reset,
  title = 'Something went wrong',
  description = 'This page hit an unexpected error. Try again, or reload if it keeps happening.',
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  description?: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex h-full min-h-[60vh] w-full flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-1.5">
        <h2 className="text-foreground text-lg font-medium">{title}</h2>
        <p className="text-muted-foreground max-w-md text-sm">{description}</p>
      </div>
      <ErrorDetails error={error} />
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          {tI18nHardcoded.raw('autoComponentsCommonRouteErrorJsxTextTryAgainfa3388ed')}
        </Button>
        <Button
          onClick={() => {
            if (typeof window !== 'undefined') window.location.reload();
          }}
        >
          Reload
        </Button>
      </div>
    </div>
  );
}
