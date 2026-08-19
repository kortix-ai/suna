'use client';

/**
 * Mint a public share for a session resource and copy its link.
 *
 * This exists because the same twelve lines were written three times — in
 * `PublicShareLinkButton`, in `browser-panel`, and (missing entirely) in
 * `app-preview`, which is how the last one ended up copying the raw
 * authenticated proxy URL instead. One owner, so the next surface that needs a
 * share link cannot quietly invent a fourth spelling.
 *
 * The link is always `{origin}{share.public_path}` — the `/share/session/{token}`
 * page, never the `/v1/p/...` proxy path. The proxy path is an implementation
 * detail the share page resolves; handing it out directly would leak the
 * sandbox id and, for the authenticated form, only work for people who already
 * have access.
 */

import { type CreateSessionPublicShareInput, createSessionPublicShare } from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { errorToast, successToast } from '@/components/ui/toast';

import { publicSharesQueryKey } from './use-session-public-shares';

export interface PublicShareLinkTarget {
  projectId?: string;
  sessionId?: string;
  input: CreateSessionPublicShareInput | null;
}

export function usePublicShareLink({ projectId, sessionId, input }: PublicShareLinkTarget) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionId || !input) {
        throw new Error('Nothing is selected to share');
      }
      const result = await createSessionPublicShare(projectId, sessionId, input);
      if (!result.share.public_path) {
        throw new Error('Share link was not returned');
      }
      const publicUrl = `${window.location.origin}${result.share.public_path}`;
      await navigator.clipboard.writeText(publicUrl);
      return publicUrl;
    },
    onSuccess: () => {
      // The management list is the only way to revoke a link, so it must never
      // lag behind a mint — a link you can't see is a link you can't revoke.
      if (projectId && sessionId) {
        void queryClient.invalidateQueries({
          queryKey: publicSharesQueryKey(projectId, sessionId),
        });
      }
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      successToast('Public link copied');
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : 'Could not create public link');
    },
  });

  return {
    copyLink: () => mutation.mutate(),
    isPending: mutation.isPending,
    copied,
    canShare: !!projectId && !!sessionId && !!input,
  };
}
