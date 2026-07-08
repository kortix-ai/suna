'use client';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { errorToast, successToast } from '@/components/ui/toast';
import { type SessionFolder, updateSessionFolder } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

type FolderShareMode = 'private' | 'project';

/**
 * Folder sharing is deliberately binary: just me, or the whole project.
 * Sharing a folder shares everything inside it BY INHERITANCE — sessions in a
 * project-shared folder become visible to every member without touching their
 * individual sharing. Per-member folder allow-lists can layer on later via the
 * reserved 'restricted' visibility.
 */
export function FolderShareModal({
  projectId,
  folder,
  open,
  onOpenChange,
}: {
  projectId: string;
  folder: SessionFolder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FolderShareMode>('private');

  useEffect(() => {
    if (open) setMode(folder?.visibility === 'project' ? 'project' : 'private');
  }, [open, folder]);

  const mutation = useMutation({
    mutationFn: (visibility: FolderShareMode) => {
      if (!folder) throw new Error('No folder selected');
      return updateSessionFolder(projectId, folder.folder_id, { visibility });
    },
    onSuccess: (_saved, visibility) => {
      queryClient.invalidateQueries({ queryKey: ['session-folders', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      successToast(
        visibility === 'project' ? 'Folder shared with the project' : 'Folder is now private',
      );
      onOpenChange(false);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to update folder sharing');
    },
  });

  const isUnchanged = (folder?.visibility === 'project' ? 'project' : 'private') === mode;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Share folder</ModalTitle>
          <ModalDescription>
            Sharing a folder shares every session inside it — including ones added later.
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as FolderShareMode)}>
            <RadioGroupItem
              value="private"
              id="folder-share-private"
              label="Just me"
              description="Only you see this folder. Sessions keep their own sharing."
              size="lg"
              variant="outline"
            />
            <RadioGroupItem
              value="project"
              id="folder-share-project"
              label="Project wide"
              description="Everyone in the project sees this folder and every session in it."
              size="lg"
              variant="outline"
            />
          </RadioGroup>
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
            onClick={() => mutation.mutate(mode)}
            disabled={mutation.isPending || isUnchanged}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
