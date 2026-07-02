'use client';

import { Button } from '@/components/ui/button';
import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';
import * as Sentry from '@sentry/nextjs';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect } from 'react';

/** Transient errors thrown while a session's sandbox/opencode runtime is still
 *  booting — a stray `getClient()` before the runtime URL is pinned. These are
 *  NOT real failures; they clear within a couple seconds. */
function isRuntimeNotReadyError(error: Error): boolean {
  const m = error?.message ?? '';
  return /server url not ready|sandbox is still loading|opencode not ready/i.test(m);
}

export default function Error({
  error,
}: {
  error: Error & { digest?: string; statusCode?: number };
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const transient = isRuntimeNotReadyError(error);

  const handleReset = () => {
    try {
      if (typeof window !== 'undefined') window.location.reload();
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (transient) return; // boot races aren't real errors — don't log/report
    console.error('[Kortix Home Error]', error);
    Sentry.captureException(error);
  }, [error, transient]);

  // Auto-recover from the sandbox-still-loading race: give the runtime a moment to
  // pin its URL, then hard-reload (the manual "Try again" path, which reliably
  // recovers) — so the user sees a brief loader instead of a hard crash.
  useEffect(() => {
    if (!transient) return;
    const t = setTimeout(() => {
      if (typeof window !== 'undefined') window.location.reload();
    }, 2000);
    return () => clearTimeout(t);
  }, [transient]);

  if (transient) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <KortixHyperLogo size={50} />
          <span className="border-muted-foreground/30 border-t-foreground size-5 animate-spin rounded-full border-2" />
          <p className="text-base-500 text-sm">Starting your session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="flex max-w-xl flex-col items-center justify-center space-y-6 text-center">
        <KortixHyperLogo size={50} />

        <div className="space-y-4">
          <h1 className="text-base-900 text-base sm:text-lg md:text-xl">
            {tI18nHardcoded.raw('autoAppErrorJsxTextSomethingWentWrong493afd7e')}
          </h1>

          {error.message && <p className="text-base-500 text-base text-balance">{error.message}</p>}
        </div>

        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <Link href="/">Home</Link>
          </Button>
          <Button onClick={handleReset} size="sm" variant="secondary">
            {tI18nHardcoded.raw('autoAppErrorJsxTextTryAgain3351b1d3')}
          </Button>
        </div>
      </div>
    </div>
  );
}
