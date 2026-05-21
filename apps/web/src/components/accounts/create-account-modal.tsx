'use client';

import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createAccount, type KortixAccount } from '@/lib/projects-client';

/**
 * Standalone modal to create a new account. Used from both the
 * /accounts page and from the WorkspaceMenu's "Create account" action.
 */
export function CreateAccountModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (account: KortixAccount) => void;
}) {
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: (account) => {
      toast.success('Account created');
      onCreated?.(account);
      setName('');
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to create account'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return toast.error('Account name is required');
    mutation.mutate({ name: trimmed });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Create an account
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Group people, projects, and billing under one account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-1.5 px-6 py-5">
            <Label htmlFor="create-account-name">Account name</Label>
            <Input
              id="create-account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme AGI"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              You can invite members and add projects after creation.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" className="gap-1.5" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create account
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
