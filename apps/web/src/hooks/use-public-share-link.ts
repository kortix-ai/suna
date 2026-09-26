'use client';

import { useTranslations } from '@/i18n/use-translations';
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
import { useProjectSession } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { errorToast, successToast } from '@/components/ui/toast';

import { publicSharesQueryKey, publicShareUrl } from './use-session-public-shares';

export interface PublicShareLinkTarget {
  projectId?: string;
  sessionId?: string;
  input: CreateSessionPublicShareInput | null;
}

export function usePublicShareLink({ projectId, sessionId, input }: PublicShareLinkTarget) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  // Minting a public link is the session OWNER's call — the link is
  // unauthenticated, so a project manager who cannot read the session must not
  // be able to mint one and read it through the URL instead (the API refuses
  // with 403). Read the same verdict the API computes rather than showing a
  // control that can only fail. Only an explicit `false` withholds it: the
  // inventory is not loaded on every surface this hook serves, and an unknown
  // answer must not silently remove a control from the owner.
  // By id, not by scanning the project's session list. The list is a bounded
  // page now, so a session older than the first page was simply absent from it
  // and the scan answered `undefined` — which this predicate reads as "not
  // false", i.e. permitted. It happened to fail OPEN (see above), so the
  // control stayed visible, but the answer was a coincidence rather than a
  // verdict. The read-by-id is exact at any age.
  const { data: session } = useProjectSession(projectId, sessionId);
  const canManageSharing = session?.can_manage_sharing !== false;
  const [copied, setCopied] = useState(false);
  // A public link is an anonymous credential. Every request to create one is
  // confirmed first (`PublicShareLinkConfirm`); nothing is minted on the click.
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      const publicUrl = publicShareUrl(result.share.public_path);
      if (!publicUrl) {
        throw new Error('Share link was not returned');
      }
      await navigator.clipboard.writeText(publicUrl);
      return publicUrl;
    },
    onSettled: () => setConfirmOpen(false),
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
      successToast(tI18nComplete.raw('textd0f24de8dbc6'));
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('text6a9dc1a2ccf5'));
    },
  });

  return {
    /** Ask to create a public link. Opens the confirmation; mints nothing. */
    copyLink: () => setConfirmOpen(true),
    /** Props for `PublicShareLinkConfirm`, which every caller renders. */
    confirmation: {
      open: confirmOpen,
      onOpenChange: (open: boolean) => {
        if (!mutation.isPending) setConfirmOpen(open);
      },
      onConfirm: () => mutation.mutate(),
      isPending: mutation.isPending,
    },
    isPending: mutation.isPending,
    copied,
    canShare: !!projectId && !!sessionId && !!input && canManageSharing,
  };
}
