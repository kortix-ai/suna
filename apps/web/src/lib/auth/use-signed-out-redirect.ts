'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { isSigningOut } from '@/lib/auth/sign-out-sequence';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Leave for `/auth` once the session is gone — the ONE signed-out guard.
 *
 * Every authenticated surface needs this because the middleware only gates the
 * REQUEST. A session that dies while a page is already mounted — an expired
 * token, a sign-out in another tab, a revoked refresh token — leaves a
 * signed-out user looking at a live screen whose every call can only 401.
 *
 * It was written out by hand at EIGHT sites. That is not a style problem: the
 * copies drifted apart the moment one of them needed the `isSigningOut()` check
 * below, and the two that got it first were the two where logging out is a rare
 * escape hatch, not the two where the logout controls actually render
 * (`project-shell.tsx` and `accounts/layout.tsx`, which mounts `AppHeader`).
 *
 * `isSigningOut()` FIRST, and this is the whole reason the guard is shared.
 * `performSignOut` fires `SIGNED_OUT` before its document load begins, so a
 * guard that only checks `!user` wins that race and reaches `/auth` by SOFT
 * navigation — carrying the App Router route cache across an identity change,
 * which is the exact defect the hard navigation exists to remove.
 *
 * A soft `replace` is right for every OTHER way a session ends: there is no
 * identity to flush that this document ever published, only a dead screen to
 * leave.
 */
export function useSignedOutRedirect(): void {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isSigningOut()) return;
    if (!isLoading && !user) router.replace('/auth');
  }, [isLoading, user, router]);
}
