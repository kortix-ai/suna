'use client';

import { useWrapperMode } from '@/app/providers';
import { clearApiKey } from '@/lib/kortix';
import { clearSessionToken } from '@/lib/session';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * Who this browser acts as. Backend mode: the Lumen Workspace user signed in to this
 * server (`/api/auth/me`). Direct mode: the pasted Kortix API key.
 */
export function useAccount() {
  const wrapper = useWrapperMode();
  const me = useQuery({
    queryKey: ['application-user'],
    queryFn: async () => {
      const response = await fetch('/api/auth/me');
      if (!response.ok) throw new Error('Not authenticated');
      return (await response.json()) as { userId: string };
    },
    enabled: wrapper,
    staleTime: 60_000,
  });
  const signOut = useCallback(() => {
    if (wrapper) {
      clearSessionToken();
      void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    } else {
      clearApiKey();
    }
    window.location.assign('/');
  }, [wrapper]);
  return {
    wrapper,
    label: wrapper ? (me.data?.userId ?? 'Signed in') : 'API key',
    mode: wrapper ? 'Backend mode' : 'Direct mode',
    signOut,
  };
}
