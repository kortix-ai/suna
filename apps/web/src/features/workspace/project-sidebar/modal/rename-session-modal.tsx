'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { updateProjectSession } from '@/lib/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

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

  const renameMutation = useMutation({
    mutationFn: (name: string) => {
      if (!sessionId) throw new Error('No session selected');
      return updateProjectSession(projectId, sessionId, { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      successToast('Session renamed');
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to rename session');
    },
  });

  const trimmed = value.trim();
  const isUnchanged = trimmed === (currentName ?? '').trim();

  const submit = () => {
    if (!sessionId || renameMutation.isPending || isUnchanged) return;
    renameMutation.mutate(trimmed);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
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
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={submit}
            disabled={renameMutation.isPending || isUnchanged}
          >
            {renameMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
