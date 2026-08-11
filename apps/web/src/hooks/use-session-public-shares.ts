'use client';

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
  type WorkspaceSessionPublicShare,
  listSessionPublicShares,
  revokeSessionPublicShare,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';

export function publicSharesQueryKey(workspaceId: string, sessionId: string) {
  return ['session-public-shares', workspaceId, sessionId] as const;
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
export function isShareLive(share: WorkspaceSessionPublicShare, now: number = Date.now()): boolean {
  if (share.revoked_at) return false;
  if (!share.expires_at) return true;
  const expiresAt = new Date(share.expires_at).getTime();
  return Number.isNaN(expiresAt) ? true : expiresAt > now;
}

export function useSessionPublicShares(workspaceId?: string, sessionId?: string) {
  const query = useQuery({
    queryKey: publicSharesQueryKey(workspaceId ?? '', sessionId ?? ''),
    queryFn: async () => {
      if (!workspaceId || !sessionId) return { shares: [] };
      return listSessionPublicShares(workspaceId, sessionId);
    },
    enabled: !!workspaceId && !!sessionId,
    // The list 403s for a workspace member who neither created the session nor
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

export function useRevokePublicShare(workspaceId?: string, sessionId?: string) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (shareId: string) => {
      if (!workspaceId || !sessionId) throw new Error('No session to revoke from');
      return revokeSessionPublicShare(workspaceId, sessionId, shareId);
    },
    onSuccess: () => {
      if (workspaceId && sessionId) {
        void queryClient.invalidateQueries({
          queryKey: publicSharesQueryKey(workspaceId, sessionId),
        });
      }
      successToast('Link revoked');
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : 'Could not revoke this link');
    },
  });

  return {
    revoke: (shareId: string) => mutation.mutate(shareId),
    revokingId: mutation.isPending ? mutation.variables : null,
  };
}
