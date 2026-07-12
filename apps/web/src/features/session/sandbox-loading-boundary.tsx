'use client';

/**
 * Safety net for the session subtree: during sandbox provisioning the opencode
 * runtime URL isn't pinned yet, and any stray `getClient()` call throws
 * "Server URL not ready — sandbox is still loading". Without this, such a throw
 * escalates to the Next route boundary (app/error.tsx) and the user sees a hard
 * "Something went wrong" instead of a loading state.
 *
 * This boundary catches ONLY those transient runtime-not-ready errors and
 * auto-retries silently until the runtime is ready. It intentionally renders no
 * fallback: the project shell is already mounted during session navigation and
 * must never be replaced by a full-page loading logo. Every other error is
 * rethrown so it bubbles to the outer boundary exactly as before.
 *
 * The gate fix in `use-runtime-sessions/keys.ts` + the guard in `session-chat`
 * should prevent these throws in the first place; this is belt-and-suspenders so
 * a missed caller degrades to "loading", never to a crash.
 */

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import { useEffect } from 'react';

/** Transient errors thrown while the sandbox/opencode runtime is still booting. */
function isRuntimeNotReadyError(error: Error): boolean {
  const m = error?.message ?? '';
  return /server url not ready|sandbox is still loading|opencode not ready/i.test(m);
}

function RuntimeLoadingFallback({ reset }: { reset: () => void }) {
  // The runtime URL lands within a second or two of provisioning. Soft-reset the
  // boundary on a short interval so the subtree re-renders and picks it up the
  // moment it's ready — no hard reload, no manual "Try again". This must stay
  // visually empty: initial project access has its own legitimate loader, but a
  // transient runtime race while switching sessions must not cover the loaded
  // project with the ASCII logo.
  useEffect(() => {
    const t = setInterval(reset, 800);
    return () => clearInterval(t);
  }, [reset]);
  return null;
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
