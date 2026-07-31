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
import type { ImportableProject } from '@/server/project-adoption';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';

/**
 * Import a project that already exists on the Kortix account.
 *
 * The project list is deliberately narrowed to what this end-user provisioned
 * through the demo — one server-held key can reach every project in the account,
 * so without that filter every signed-in user would see the operator's whole
 * workspace. That boundary stays; this is an explicit, gated way to say "this
 * one is mine too", which is what makes the demo usable against a project that
 * already has connectors and secrets.
 *
 * Hidden entirely unless the deployment opts in, and the copy says why rather
 * than presenting it as an ordinary feature — a wrapper author reading this app
 * as a reference should not copy it by accident.
 */
export function ImportProjectsDialog() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const available = useQuery({
    queryKey: ['importable-projects'],
    queryFn: async (): Promise<{ projects: ImportableProject[]; error?: string }> => {
      const res = await fetch('/api/projects/import');
      if (res.status === 403) return { projects: [], error: (await res.json()).error };
      if (!res.ok) throw new Error('Could not read the account’s projects.');
      return res.json();
    },
    enabled: open,
  });

  const importProject = useMutation({
    mutationFn: async (projectId: string) => {
      const res = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Import failed');
      return projectId;
    },
    onSuccess: () => {
      toast.success('Project imported');
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['importable-projects'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = available.data?.projects ?? [];
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
          <DialogTitle>Import a project</DialogTitle>
          <DialogDescription>
            This list is normally hidden. A wrapper narrows projects to what each end-user started,
            because one server-held key can reach the whole account — importing is a testing
            affordance, not something a real product would offer its users.
          </DialogDescription>
        </DialogHeader>

        {gateMessage ? (
          <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
            {gateMessage}
          </p>
        ) : available.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the account’s projects…</p>
        ) : available.isError ? (
          <p className="text-sm text-destructive">Could not read the account’s projects.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects on this account.</p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {rows.map((project) => (
              <li
                key={project.project_id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-popover px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{project.name || 'Untitled'}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {project.project_id}
                  </p>
                </div>
                {project.imported ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Already yours</span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={importProject.isPending}
                    onClick={() => importProject.mutate(project.project_id)}
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
