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
import type { ProjectSession } from '@kortix/sdk';
import { updateProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import {
  applyRenameResponse,
  beginOptimisticRename,
  rollbackOptimisticRename,
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

  // The optimistic write below targets the DEFAULT ('visible') scope only —
  // that is the scope every reader except the manager-only inventory page
  // uses, and the only one this component has a cached row to paint over.
  // `onSettled`'s invalidation, further down, uses the sessionsScope PREFIX
  // instead, so the 'project'-scoped inventory page (never painted
  // optimistically) still catches up via a real refetch.
  const sessionsQueryKey = qk.project.sessions(projectId);

  const renameMutation = useMutation({
    mutationFn: (name: string) => {
      if (!sessionId) throw new Error('No session selected');
      return updateProjectSession(projectId, sessionId, { name });
    },
    // Optimistic write: the sidebar, the header, and every other reader of
    // `sessionsQueryKey` (seven in total) show the new name before the
    // network round-trip completes, instead of waiting for the refetch this
    // mutation triggers on settle.
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: sessionsQueryKey });
      return beginOptimisticRename(queryClient, sessionsQueryKey, sessionId, name);
    },
    onSuccess: (updated, name) => {
      // Write the server's own response into the cache rather than discard
      // it — it is the authoritative name (normalized) and a fresh
      // `updated_at`, so this replaces the optimistic guess from `onMutate`
      // with the real thing. MERGED, not substituted: the PATCH response
      // carries fewer fields than the list row — see `applyRenameResponse`.
      queryClient.setQueryData<ProjectSession[]>(sessionsQueryKey, (sessions) =>
        sessions ? applyRenameResponse(sessions, updated) : sessions,
      );
      successToast(name ? `Renamed to "${name}"` : 'Session renamed');
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err, _name, context) => {
      rollbackOptimisticRename(queryClient, sessionsQueryKey, context?.previous);
      errorToast(err instanceof Error ? err.message : 'Failed to rename session');
    },
    onSettled: () => {
      // The server stays authoritative: this refetch reconciles the cache
      // with reality even though onSuccess already wrote the response, e.g.
      // if another tab changed the session in between. The PREFIX, not
      // `sessionsQueryKey`: a rename has to reach every scope, not just the
      // default one this component wrote to optimistically.
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
            Cancel
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={submit}
            disabled={renameMutation.isPending || isUnchanged}
          >
            {renameMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
