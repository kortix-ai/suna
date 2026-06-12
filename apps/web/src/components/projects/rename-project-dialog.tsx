'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { updateProject } from '@/lib/projects-client';

interface RenameProjectDialogProps {
  projectId: string | null;
  /** Current project name, prefilled into the input. */
  currentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

const MAX_NAME_LENGTH = 120;

export function RenameProjectDialog({
  projectId,
  currentName,
  open,
  onOpenChange,
  onSaved,
}: RenameProjectDialogProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(currentName ?? '');

  // Reset the field whenever a new project opens the dialog.
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
      toast.success('Project renamed');
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to rename project');
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            Give this project a new name.
          </DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={renameMutation.isPending || isUnchanged || isEmpty}
          >
            {renameMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
