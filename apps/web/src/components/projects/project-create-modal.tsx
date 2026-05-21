'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { provisionProject } from '@/lib/projects-client';

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
}

/**
 * New project = a managed Kortix git repo (Freestyle) seeded with the starter.
 * No GitHub account, no repo-name uniqueness, no import dance — the project is
 * live and bootable the moment it's created. (Bringing your own / external
 * repos with auth is handled separately via the vault-backed git remote model,
 * not this dialog.)
 */
export function ProjectCreateModal({ open, onOpenChange, accountId }: ProjectCreateModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [newName, setNewName] = useState('');

  function resetAndClose() {
    setNewName('');
    onOpenChange(false);
  }

  const createMutation = useMutation({
    mutationFn: provisionProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project created');
      resetAndClose();
      router.push(`/projects/${project.project_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create project');
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const name = newName.trim();
    if (!name) return toast.error('Project name is required');
    if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
      return toast.error('Use letters, numbers, spaces, hyphens, underscores, or dots only');
    }
    createMutation.mutate({ account_id: accountId, name });
  }

  const submitting = createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">New project</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            A fresh workspace on Kortix — its own git repo, ready in seconds.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="px-6 pb-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-name" className="text-xs font-medium text-muted-foreground">
              Project name
            </Label>
            <Input
              id="new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="my-agi-company"
              autoCapitalize="none"
              autoCorrect="off"
              className="font-mono text-sm h-10"
              autoFocus
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={resetAndClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" className="gap-1.5" disabled={submitting || !accountId}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
