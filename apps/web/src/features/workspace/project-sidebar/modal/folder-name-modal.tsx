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
import {
  createSessionFolder,
  updateSessionFolder,
  type SessionFolder,
} from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const MAX_NAME_LENGTH = 120;

/**
 * One modal for both "New folder" (folder == null) and "Rename folder".
 * On create, `onCreated` receives the fresh folder so callers can chain
 * (e.g. immediately move a session into it).
 */
export function FolderNameModal({
  projectId,
  folder,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  folder: SessionFolder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (folder: SessionFolder) => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const isRename = !!folder;

  useEffect(() => {
    if (open) setValue(folder?.name ?? '');
  }, [open, folder]);

  const mutation = useMutation({
    mutationFn: async (name: string) => {
      if (folder) return updateSessionFolder(projectId, folder.folder_id, { name });
      return createSessionFolder(projectId, { name });
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['session-folders', projectId] });
      successToast(isRename ? 'Folder renamed' : 'Folder created');
      if (!isRename && saved) onCreated?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to save folder');
    },
  });

  const trimmed = value.trim();
  const isUnchanged = isRename && trimmed === (folder?.name ?? '').trim();
  const canSubmit = !!trimmed && !isUnchanged && !mutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    mutation.mutate(trimmed);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{isRename ? 'Rename folder' : 'New folder'}</ModalTitle>
          <ModalDescription>
            {isRename
              ? 'Give this folder a new name.'
              : 'Group sessions into a folder to keep the sidebar organized.'}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Input
            autoFocus
            value={value}
            maxLength={MAX_NAME_LENGTH}
            placeholder="e.g. Growth experiments"
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
          <Button size="sm" className="w-full sm:w-auto" onClick={submit} disabled={!canSubmit}>
            {mutation.isPending ? 'Saving…' : isRename ? 'Save' : 'Create folder'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
