'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Read and revoke a session's public share links.
 *
 * The API has had list and revoke since the table was introduced; nothing in
 * the app ever called them, so links could be minted but never seen or taken
 * back. An unrevocable public link to a workspace file is worse than no share
 * feature at all, which is why this sits alongside the mint path rather than
 * behind it.
 */

import {
  type CreateSessionPublicShareInput,
  type SessionPublicShare,
  listSessionPublicShares,
  revokeSessionPublicShare,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';

export function publicSharesQueryKey(projectId: string, sessionId: string) {
  return ['session-public-shares', projectId, sessionId] as const;
}

export type ShareListState = 'loading' | 'error' | 'empty' | 'list';

/**
 * Which of the four panel states the share list is in.
 *
 * Extracted from the component because the order matters and the wrong order is
 * a lie rather than a cosmetic bug: `isError` MUST beat the empty check, or a
 * member who is denied the list (403 — see `canManageSharing`) is told nothing
 * is shared, which may simply be false.
 */
export function shareListState(input: {
  isLoading: boolean;
  isError: boolean;
  count: number;
}): ShareListState {
  if (input.isLoading) return 'loading';
  if (input.isError) return 'error';
  return input.count === 0 ? 'empty' : 'list';
}

/** A share that is still handing out access right now. */
export function isShareLive(share: SessionPublicShare, now: number = Date.now()): boolean {
  if (share.revoked_at) return false;
  if (!share.expires_at) return true;
  const expiresAt = new Date(share.expires_at).getTime();
  return Number.isNaN(expiresAt) ? true : expiresAt > now;
}

/** A file path as the API stores it: always `/workspace/<relative path>`. */
function workspaceFilePath(path: string): string {
  const rel = path.replace(/^\/?workspace\/?/, '').split('/').filter(Boolean).join('/');
  return `/workspace/${rel}`;
}

/**
 * Every live share that already exposes what `input` would share, newest
 * first (the order the API lists them in).
 *
 * Only transcripts are reused by the API; a file or preview mint always makes
 * a new token, so one file can carry several live links. A surface that offers
 * "Copy link" shows the newest and revokes all of them together — revoking
 * only one left the next one live and the popover looking unchanged.
 */
export function findLiveSharesFor(
  shares: readonly SessionPublicShare[],
  input: CreateSessionPublicShareInput | null,
  now: number = Date.now(),
): SessionPublicShare[] {
  if (!input) return [];
  const live = shares.filter((share) => isShareLive(share, now));
  if (input.file) {
    const filePath = workspaceFilePath(input.file.path);
    return live.filter((s) => s.resource_type === 'file' && s.file_path === filePath);
  }
  const preview = input.preview;
  if (preview?.port) {
    const path = preview.path || '/';
    return live.filter(
      (s) => s.resource_type === 'preview' && s.port === preview.port && s.path === path,
    );
  }
  return [];
}

/** The newest live share for `input`, or null. See `findLiveSharesFor`. */
export function findLiveShareFor(
  shares: readonly SessionPublicShare[],
  input: CreateSessionPublicShareInput | null,
  now: number = Date.now(),
): SessionPublicShare | null {
  return findLiveSharesFor(shares, input, now)[0] ?? null;
}

/**
 * The link a person opens: `{web origin}{share.public_path}`, the
 * `/share/session/{token}` page — never the `/v1/p/...` proxy path, which
 * leaks the sandbox id. The one place that joins them. `origin` defaults to
 * this window's; outside a browser there is none, so the result is null.
 */
export function publicShareUrl(
  publicPath: string | null | undefined,
  origin: string | null = typeof window === 'undefined' ? null : window.location.origin,
): string | null {
  if (!publicPath || !origin) return null;
  return `${origin}${publicPath}`;
}

export function useSessionPublicShares(projectId?: string, sessionId?: string) {
  const query = useQuery({
    queryKey: publicSharesQueryKey(projectId ?? '', sessionId ?? ''),
    queryFn: async () => {
      if (!projectId || !sessionId) return { shares: [] };
      return listSessionPublicShares(projectId, sessionId);
    },
    enabled: !!projectId && !!sessionId,
    // The list 403s for a project member who neither created the session nor
    // has manage rights. That is a settled answer, not a blip, so retrying it
    // three times on every panel mount just multiplies a guaranteed failure.
    retry: false,
    staleTime: 30_000,
  });

  const shares = query.data?.shares ?? [];

  return {
    shares,
    liveShares: shares.filter((share) => isShareLive(share)),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useRevokePublicShare(projectId?: string, sessionId?: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (shareIds: string[]) => {
      if (!projectId || !sessionId) throw new Error('No session to revoke from');
      return Promise.all(
        shareIds.map((shareId) => revokeSessionPublicShare(projectId, sessionId, shareId)),
      );
    },
    onSuccess: () => {
      if (projectId && sessionId) {
        void queryClient.invalidateQueries({
          queryKey: publicSharesQueryKey(projectId, sessionId),
        });
      }
      successToast(tI18nComplete.raw('textbeffd2472832'));
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('text46c307963f84'));
    },
  });

  return {
    revoke: (shareId: string) => mutation.mutate([shareId]),
    /** Revoke several links in one action, e.g. every live link to one file. */
    revokeAll: (shareIds: string[]) => mutation.mutate(shareIds),
    revokingId: mutation.isPending && mutation.variables?.length === 1 ? mutation.variables[0] : null,
    isRevoking: mutation.isPending,
  };
}
