'use client';

/**
 * Safety net for the session subtree: during sandbox provisioning the opencode
 * runtime URL isn't pinned yet, and any stray `getClient()` call throws
 * "Server URL not ready — sandbox is still loading". Without this, such a throw
 * escalates to the Next route boundary (app/error.tsx) and the user sees a hard
 * "Something went wrong" instead of a loading state.
 *
 * This boundary catches ONLY those transient runtime-not-ready errors and shows
 * the normal provisioning loader, auto-retrying until the runtime is ready. Every
 * other error is rethrown so it bubbles to the outer boundary exactly as before.
 *
 * The gate fix in `use-opencode-sessions/keys.ts` + the guard in `session-chat`
 * should prevent these throws in the first place; this is belt-and-suspenders so
 * a missed caller degrades to "loading", never to a crash.
 */

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { useEffect } from 'react';

/** Transient errors thrown while the sandbox/opencode runtime is still booting. */
function isRuntimeNotReadyError(error: Error): boolean {
  const m = error?.message ?? '';
  return /server url not ready|sandbox is still loading|opencode not ready/i.test(m);
}

function RuntimeLoadingFallback({ reset }: { reset: () => void }) {
  // The runtime URL lands within a few seconds of provisioning. Reset the
  // boundary on a short interval so the subtree re-mounts and picks it up once
  // ready — no manual "Try again" needed.
  useEffect(() => {
    const t = setInterval(reset, 1200);
    return () => clearInterval(t);
  }, [reset]);
  return <SessionStartingLoader stage="provisioning" delayMs={0} />;
}

// Rethrow non-runtime errors so they propagate to the nearest OUTER boundary
// (a boundary doesn't catch throws from its own fallback render).
function Rethrow({ error }: { error: Error }): never {
  throw error;
}

export function SandboxLoadingBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ClientErrorBoundary
      fallback={({ error, reset }) =>
        isRuntimeNotReadyError(error) ? (
          <RuntimeLoadingFallback reset={reset} />
        ) : (
          <Rethrow error={error} />
        )
      }
    >
      {children}
    </ClientErrorBoundary>
  );
}
