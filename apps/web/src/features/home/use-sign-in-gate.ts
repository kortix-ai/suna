'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { writePendingPrompt } from '@/lib/home/pending-prompt';

/**
 * Every action on the logged-out homepage funnels through here: show the
 * product, gate the doing.
 */
export function useSignInGate() {
  const router = useRouter();

  const gate = useCallback(
    (returnTo = '/') => {
      // Same-origin paths only — `returnTo` ends up in a redirect.
      const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
      router.push(`/auth?returnUrl=${encodeURIComponent(safe)}`);
    },
    [router],
  );

  /** Carry what they typed across sign-in, then gate. */
  const gateWithPrompt = useCallback(
    (text: string) => {
      writePendingPrompt(text);
      gate('/');
    },
    [gate],
  );

  return { gate, gateWithPrompt };
}
