'use client';

import { Button } from '../../../primitives/button';
import { Input } from '../../../primitives/input';
import Loading from '../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import { useTranslations } from '../../../i18n';
import { useState } from 'react';

import { MAX_SESSION_NAME_LENGTH, useRenameSession } from '../../../session/actions/use-rename-session';

interface RenameSessionModalProps {
  projectId: string;
  sessionId: string | null;
  currentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

export function RenameSessionModal({
  projectId,
  sessionId,
  currentName,
  open,
  onOpenChange,
  onSaved,
}: RenameSessionModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [value, setValue] = useState(currentName ?? '');

  const [syncedFor, setSyncedFor] = useState<[boolean, string | undefined]>([
    open,
    currentName,
  ]);
  if (syncedFor[0] !== open || syncedFor[1] !== currentName) {
    setSyncedFor([open, currentName]);
    if (open) setValue(currentName ?? '');
  }

  const renameMutation = useRenameSession(projectId, sessionId, {
    onSuccess: () => {
      onSaved?.();
      onOpenChange(false);
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
            maxLength={MAX_SESSION_NAME_LENGTH}
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
