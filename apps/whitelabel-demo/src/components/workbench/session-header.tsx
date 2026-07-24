'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { kortix } from '@/lib/kortix';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import {
  type MessageWithParts,
  formatTranscript,
  getTranscriptFilename,
  isRuntimeReady,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, MoreVertical, Pause, Pencil, RotateCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

export function SessionHeader({
  projectId,
  sessionId,
  messages,
}: {
  projectId: string;
  sessionId: string;
  /** The live thread from `useSession`, when ready — powers transcript export. */
  messages?: MessageWithParts[];
}) {
  const session = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).get({ showErrors: false }),
    // The status badge must track boot/stop transitions, not the first fetch.
    refetchInterval: 15_000,
    retry: false,
  });
  const title =
    session.data?.name || session.data?.custom_name || session.data?.branch_name || 'Session';
  const status = session.data?.status;

  // Runtime liveness probe (GET /kortix/health) for the header dot.
  const health = useQuery({
    queryKey: ['session-health', projectId, sessionId],
    queryFn: () => kortix.session(projectId, sessionId).health(),
    refetchInterval: 15_000,
    retry: false,
  });
  const ready = health.data?.ok && isRuntimeReady(health.data?.health ?? null);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          ready ? 'bg-emerald-500' : health.data ? 'bg-amber-500' : 'bg-muted-foreground/40',
        )}
        title={ready ? 'Runtime healthy' : 'Runtime warming up'}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
      </div>
      {status && (
        <Badge variant="secondary" className="capitalize">
          {status}
        </Badge>
      )}
      <SessionActions
        projectId={projectId}
        sessionId={sessionId}
        currentName={title}
        created={session.data?.created_at}
        updated={session.data?.updated_at}
        messages={messages}
      />
    </header>
  );
}

/** Session lifecycle actions: rename, restart, stop, export transcript, delete. */
function SessionActions({
  projectId,
  sessionId,
  currentName,
  created,
  updated,
  messages,
}: {
  projectId: string;
  sessionId: string;
  currentName: string;
  created?: string;
  updated?: string;
  messages?: MessageWithParts[];
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');

  const rename = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).update({ name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(projectId, sessionId) });
      invalidateSessions(qc, projectId);
      setRenaming(false);
      toast.success('Session renamed');
    },
    onError: () => toast.error('Could not rename'),
  });
  const restart = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).restart(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionStart(projectId, sessionId) });
      toast.success('Restarting the session…');
    },
    onError: () => toast.error('Could not restart'),
  });
  const stop = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).stop(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(projectId, sessionId) });
      qc.invalidateQueries({ queryKey: ['session-health', projectId, sessionId] });
      invalidateSessions(qc, projectId);
      toast.success('Runtime stopped. Reopen the session to resume.');
    },
    onError: () => toast.error('Could not stop the runtime'),
  });
  const remove = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).delete(),
    onSuccess: () => {
      invalidateSessions(qc, projectId);
      toast.success('Session deleted');
      router.push(`/projects/${projectId}`);
    },
    onError: () => toast.error('Could not delete'),
  });

  const exportTranscript = () => {
    if (!messages?.length) return;
    const markdown = formatTranscript(
      {
        id: sessionId,
        title: currentName,
        time: {
          created: created ? new Date(created).getTime() : Date.now(),
          updated: updated ? new Date(updated).getTime() : Date.now(),
        },
      },
      messages,
    );
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getTranscriptFilename(sessionId);
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Transcript downloaded');
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Session actions">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setName(currentName);
              setRenaming(true);
            }}
          >
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportTranscript} disabled={!messages?.length}>
            <Download className="size-4" /> Export transcript
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => restart.mutate()} disabled={restart.isPending}>
            <RotateCw className="size-4" /> Restart
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Pause className="size-4" /> Stop runtime
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && rename.mutate()}
          />
          <DialogFooter>
            <Button disabled={!name.trim() || rename.isPending} onClick={() => rename.mutate()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
