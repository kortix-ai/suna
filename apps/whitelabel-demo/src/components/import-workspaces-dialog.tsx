'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { ImportableWorkspace } from '@/server/workspace-adoption';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';

/**
 * Import a workspace that already exists on the Kortix account.
 *
 * The workspace list is deliberately narrowed to what this end-user provisioned
 * through the demo — one server-held key can reach every workspace in the account,
 * so without that filter every signed-in user would see the operator's whole
 * workspace. That boundary stays; this is an explicit, gated way to say "this
 * one is mine too", which is what makes the demo usable against a workspace that
 * already has connectors and secrets.
 *
 * Hidden entirely unless the deployment opts in, and the copy says why rather
 * than presenting it as an ordinary feature — a wrapper author reading this app
 * as a reference should not copy it by accident.
 */
export function ImportWorkspacesDialog() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const available = useQuery({
    queryKey: ['importable-workspaces'],
    queryFn: async (): Promise<{ workspaces: ImportableWorkspace[]; error?: string }> => {
      const res = await fetch('/api/workspaces/import');
      if (res.status === 403) return { workspaces: [], error: (await res.json()).error };
      if (!res.ok) throw new Error('Could not read the account’s workspaces.');
      return res.json();
    },
    enabled: open,
  });

  const importWorkspace = useMutation({
    mutationFn: async (workspaceId: string) => {
      const res = await fetch('/api/workspaces/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Import failed');
      return workspaceId;
    },
    onSuccess: () => {
      toast.success('Workspace imported');
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['importable-workspaces'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = available.data?.workspaces ?? [];
  const gateMessage = available.data?.error;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <Download className="size-4 shrink-0" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a workspace</DialogTitle>
          <DialogDescription>
            This list is normally hidden. A wrapper narrows workspaces to what each end-user started,
            because one server-held key can reach the whole account — importing is a testing
            affordance, not something a real product would offer its users.
          </DialogDescription>
        </DialogHeader>

        {gateMessage ? (
          <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
            {gateMessage}
          </p>
        ) : available.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the account’s workspaces…</p>
        ) : available.isError ? (
          <p className="text-sm text-destructive">Could not read the account’s workspaces.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspaces on this account.</p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {rows.map((workspace) => (
              <li
                key={workspace.workspace_id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-popover px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{workspace.name || 'Untitled'}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {workspace.workspace_id}
                  </p>
                </div>
                {workspace.imported ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Already yours</span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={importWorkspace.isPending}
                    onClick={() => importWorkspace.mutate(workspace.workspace_id)}
                  >
                    Import
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
