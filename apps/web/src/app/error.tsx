'use client';

import { Button } from '@/components/ui/button';
import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';
import * as Sentry from '@sentry/nextjs';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Transient "the sandbox/opencode runtime URL isn't pinned yet" throw. It fires
 * during provisioning and — critically — for a beat on every SESSION SWITCH,
 * before the new session's runtime URL resolves, and it ALWAYS self-heals within
 * a second or two. `SandboxLoadingBoundary` catches it inside the session
 * subtree, but a caller mounted OUTSIDE that subtree (a shell/layout component,
 * or a stale-bundle race) lets it reach this global boundary. Such a transient
 * error must NEVER present as the hard "Something went wrong" crash — degrade it
 * to a silent auto-retry here too. Match on message text (the throw is a plain
 * `RuntimeNotReadyError`, but sibling env/pty guards reuse the same wording).
 */
function isRuntimeNotReadyError(error: Error): boolean {
  const m = error?.message ?? '';
  return /server url not ready|sandbox is still loading|opencode not ready/i.test(m);
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string; statusCode?: number };
  reset: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const runtimeNotReady = isRuntimeNotReadyError(error);

  const handleReset = () => {
    try {
      if (typeof window !== 'undefined') window.location.reload();
    } catch (e) {
      console.error(e);
    }
  };

  // Transient runtime-not-ready: soft-reset the segment on a short interval so it
  // re-renders and picks up the runtime URL the moment it pins — no hard reload,
  // no crash card. Mirrors SandboxLoadingBoundary's belt-and-suspenders retry.
  useEffect(() => {
    if (!runtimeNotReady) return;
    const t = setInterval(() => reset(), 800);
    return () => clearInterval(t);
  }, [runtimeNotReady, reset]);

  // Only genuine crashes are worth logging / reporting. A transient
  // runtime-not-ready race is expected background noise during a session switch.
  useEffect(() => {
    if (runtimeNotReady) return;
    console.error('[Kortix Home Error]', error);
    Sentry.captureException(error);
  }, [error, runtimeNotReady]);

  if (runtimeNotReady) {
    // A calm, minimal loader — the route re-mounts as soon as the URL lands.
    return (
      <div
        className="bg-background flex min-h-screen items-center justify-center"
        role="status"
        aria-label="Loading session"
      >
        <KortixHyperLogo size={34} startOnView={false} animateOnHover={false} />
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
