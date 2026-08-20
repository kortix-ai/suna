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

import {
  type CreateSessionPublicShareInput,
  createSessionPublicShare,
  listProjectSessions,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  // Minting a public link is the session OWNER's call — the link is
  // unauthenticated, so a project manager who cannot read the session must not
  // be able to mint one and read it through the URL instead (the API refuses
  // with 403). Read the same verdict the API computes rather than showing a
  // control that can only fail. Only an explicit `false` withholds it: the
  // inventory is not loaded on every surface this hook serves, and an unknown
  // answer must not silently remove a control from the owner.
  const { data: sessions } = useQuery({
    queryKey: qk.project.sessions(projectId ?? ''),
    queryFn: () => listProjectSessions(projectId!),
    enabled: !!projectId && !!sessionId,
    ...contract('inventory'),
  });
  const canManageSharing =
    sessions?.find((s) => s.session_id === sessionId)?.can_manage_sharing !== false;
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
    canShare: !!projectId && !!sessionId && !!input && canManageSharing,
  };
}
