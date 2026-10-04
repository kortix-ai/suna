import { useEffect, useRef } from 'react';
import type { ReadonlyURLSearchParams } from 'next/navigation';
import { armPkceResumeGuard, consumePkceResumeGuard, seedPkceVerifierForResume } from '@/lib/auth/pkce-resume';

/**
 * A bounced-back PKCE code: the server-side exchange in /auth/callback failed
 * because this browser's verifier cookie did not survive the mailbox detour,
 * and the code is still fresh and unconsumed. Re-seed the verifier this tab
 * snapshotted when the send ran and re-enter the callback, whose normal
 * exchange and success path (return-URL demotion, terms stamp, billing-aware
 * landing) then run unchanged. One shot: a re-seeded exchange that still
 * bounces goes to the resend screen, never a loop. The params are stripped
 * first so a refresh cannot re-arm a spent resume.
 */
export function usePkceResume(
  searchParams: ReadonlyURLSearchParams,
  isLoading: boolean,
  returnUrl: string,
) {
  const hasResumedPkceCode = useRef(false);

  const pkceResumeCode = searchParams.get('pkce_code');
  useEffect(() => {
    if (!pkceResumeCode || hasResumedPkceCode.current || isLoading) return;
    hasResumedPkceCode.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('pkce_code');
    window.history.replaceState(null, '', url.toString());
    const resendUrl = new URL('/auth', window.location.origin);
    resendUrl.searchParams.set('expired', 'true');
    if (returnUrl) resendUrl.searchParams.set('returnUrl', returnUrl);
    if (consumePkceResumeGuard(pkceResumeCode) || !seedPkceVerifierForResume()) {
      // The re-seeded exchange already bounced once, or this tab holds no
      // snapshot (the link was opened elsewhere) and no cookie. The exchange
      // cannot complete here either way — the resend screen is the honest
      // landing, with the return URL preserved for the next attempt.
      window.location.assign(resendUrl.toString());
      return;
    }
    armPkceResumeGuard(pkceResumeCode);
    const target = new URL('/auth/callback', window.location.origin);
    target.searchParams.set('code', pkceResumeCode);
    if (returnUrl) target.searchParams.set('returnUrl', returnUrl);
    window.location.assign(target.toString());
  }, [pkceResumeCode, isLoading, returnUrl]);
}
