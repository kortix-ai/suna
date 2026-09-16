'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { updateProjectSession } from '@kortix/sdk';
import { qk, updateCachedProjectSessions } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useState } from 'react';

import {
  applyRenameResponse,
  applySessionRename,
} from './rename-session-cache';

interface RenameSessionModalProps {
  projectId: string;
  sessionId: string | null;
  currentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

const MAX_NAME_LENGTH = 120;

export function RenameSessionModal({
  projectId,
  sessionId,
  currentName,
  open,
  onOpenChange,
  onSaved,
}: RenameSessionModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [value, setValue] = useState(currentName ?? '');

  useEffect(() => {
    if (open) setValue(currentName ?? '');
  }, [open, currentName]);

  // The optimistic write below reaches EVERY cached session shape and scope
  // for this project — see `updateCachedProjectSessions`.

  const renameMutation = useMutation({
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
      onSaved?.();
      onOpenChange(false);
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

  const trimmed = value.trim();
  const isUnchanged = trimmed === (currentName ?? '').trim();

  const submit = () => {
    if (!sessionId || renameMutation.isPending || isUnchanged) return;
    renameMutation.mutate(trimmed);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!renameMutation.isPending) onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectSidebarModalRenameSessionModalJsx265e123d',
            )}
          </ModalTitle>
          <ModalDescription>
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectSidebarModalRenameSessionModalJsx19d80686',
            )}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Input
            autoFocus
            value={value}
            maxLength={MAX_NAME_LENGTH}
            placeholder={tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectSidebarModalRenameSessionModalJsx2412472b',
            )}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={renameMutation.isPending}
          >
            {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={submit}
            disabled={renameMutation.isPending || isUnchanged}
          >
            {renameMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nHardcoded.raw('i18nComplete.text1509f561f241')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
