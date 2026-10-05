'use client';

import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { updateProjectSession } from '@kortix/sdk';
import { qk, updateCachedProjectSessions } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { applyRenameResponse, applySessionRename } from './rename-session-cache';

export const MAX_SESSION_NAME_LENGTH = 120;

/**
 * The one rename mutation. The modal (sidebar, sessions list) and the session
 * header's inline editor both save through it, so the optimistic write, the
 * toast, and the revert path cannot drift between the two entry points.
 */
export function useRenameSession(
  projectId: string,
  sessionId: string | null,
  { onSuccess }: { onSuccess?: () => void } = {},
) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();

  // The optimistic write below reaches EVERY cached session shape and scope
  // for this project — see `updateCachedProjectSessions`.
  return useMutation({
    mutationFn: (name: string) => {
      if (!sessionId) throw new Error('No session selected');
      return updateProjectSession(projectId, sessionId, { name });
    },
    // Optimistic write: the sidebar, the header, and every other reader of
    // this project's sessions show the new name before the network round-trip
    // completes, instead of waiting for the refetch this mutation triggers on
    // settle.
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: qk.project.sessionsScope(projectId) });
      // Writes through EVERY cached shape — the sidebar's paged cache, the flat
      // lists, and the single-row entry — not just the flat key. The sidebar
      // moved to `useInfiniteQuery` when this list became a bounded page, and a
      // write aimed at the flat key alone stopped reaching the surface the user
      // is actually looking at.
      updateCachedProjectSessions(queryClient, projectId, (sessions) =>
        sessionId ? applySessionRename(sessions, sessionId, name) : sessions,
      );
    },
    onSuccess: (updated, name) => {
      // Write the server's own response into the cache rather than discard
      // it — it is the authoritative name (normalized) and a fresh
      // `updated_at`, so this replaces the optimistic guess from `onMutate`
      // with the real thing. MERGED, not substituted: the PATCH response
      // carries fewer fields than the list row — see `applyRenameResponse`.
      updateCachedProjectSessions(queryClient, projectId, (sessions) =>
        applyRenameResponse(sessions, updated),
      );
      successToast(
        name
          ? tI18nHardcoded('i18nComplete.textac667905c07f', { value0: name })
          : tI18nHardcoded.raw('i18nComplete.text84af5fd8082c'),
      );
      onSuccess?.();
    },
    onError: (err) => {
      // The server reverts this, not a snapshot. The optimistic write now spans
      // several cache shapes, so restoring one captured array would leave the
      // others holding the failed name; `onSettled` invalidates the whole
      // sessions prefix immediately after this, which puts every shape back to
      // server truth in one pass.
      errorToast(
        err instanceof Error ? err.message : tI18nHardcoded.raw('i18nComplete.text8d0a49d459d7'),
      );
    },
    onSettled: () => {
      // The server stays authoritative: this refetch reconciles the cache
      // with reality even though onSuccess already wrote the response, e.g.
      // if another tab changed the session in between. It is also the revert
      // path for a failed rename — see `onError`.
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
  });
}
