'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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
import { updateProject } from '@/lib/projects-client';

interface RenameProjectDialogProps {
  projectId: string | null;
  currentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

const MAX_NAME_LENGTH = 120;

export const RenameProjectDialog = ({
  projectId,
  currentName,
  open,
  onOpenChange,
  onSaved,
}: RenameProjectDialogProps) => {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(currentName ?? '');

  useEffect(() => {
    if (open) setValue(currentName ?? '');
  }, [open, currentName]);

  const renameMutation = useMutation({
    mutationFn: (name: string) => {
      if (!projectId) throw new Error('No project selected');
      return updateProject(projectId, { name });
    },
    onSuccess: (updated) => {
      if (projectId) {
        queryClient.setQueryData(['project', projectId], updated);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      successToast('Project renamed');
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to rename project');
    },
  });

  const trimmed = value.trim();
  const isUnchanged = trimmed === (currentName ?? '').trim();
  const isEmpty = trimmed.length === 0;

  const submit = () => {
    if (!projectId || renameMutation.isPending || isUnchanged || isEmpty) return;
    renameMutation.mutate(trimmed);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Rename project</ModalTitle>
          <ModalDescription>Give this project a new name.</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Input
            autoFocus
            value={value}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Project name"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
        </ModalBody>
        <ModalFooter className='sm:justify-between'>
          <Button variant="outline-ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={renameMutation.isPending || isUnchanged || isEmpty}>
            {renameMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
