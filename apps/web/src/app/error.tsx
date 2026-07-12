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
  // runtime-not-ready race is expected background noise during a session switch —
  // it is an info state, not an error, so it goes to the console and nowhere else.
  useEffect(() => {
    if (runtimeNotReady) {
      console.debug('[runtime] not ready yet (sandbox still loading) — retrying', error?.message);
      return;
    }
    console.error('[Kortix Home Error]', error);
    Sentry.captureException(error);
  }, [error, runtimeNotReady]);

  if (runtimeNotReady) {
    // Render NOTHING. "Sandbox still loading" is a transient info state, never an
    // error UI — no logo, no card, no message. We silently soft-reset (above) until
    // the runtime URL pins, at which point the real page renders in place. The only
    // trace is the console.debug. This is the last-ditch backstop; the session
    // subtree's own gating + SandboxLoadingBoundary normally prevent the throw from
    // ever reaching here at all.
    return null;
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
