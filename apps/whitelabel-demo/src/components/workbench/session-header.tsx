'use client';

import Loading from '@/components/ui/loading';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { ModelSwitcher } from '@/components/workbench/model-switcher';
import { kortix } from '@/lib/kortix';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { isRuntimeReady } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Pencil, RotateCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

export function SessionHeader({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const session = useQuery({
    queryKey: qk.session(workspaceId, sessionId),
    queryFn: () => kortix.session(workspaceId, sessionId).get({ showErrors: false }),
    retry: false,
  });
  const title =
    session.data?.name || session.data?.custom_name || session.data?.branch_name || 'Session';
  const status = session.data?.status;

  // Runtime liveness probe (GET /kortix/health) for the header dot.
  const health = useQuery({
    queryKey: ['session-health', workspaceId, sessionId],
    queryFn: () => kortix.session(workspaceId, sessionId).health(),
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
      {/* Mid-session model change. Placed by the status badge because switching
          restarts the runtime and ends the in-flight turn — it belongs with the
          session's live state, not buried in settings. */}
      <ModelSwitcher workspaceId={workspaceId} sessionId={sessionId} />
      {status && (
        <Badge variant="secondary" className="capitalize">
          {status}
        </Badge>
      )}
      <SessionActions workspaceId={workspaceId} sessionId={sessionId} currentName={title} />
    </header>
  );
}

/** Session lifecycle actions: rename (update), restart, delete. */
function SessionActions({
  workspaceId,
  sessionId,
  currentName,
}: {
  workspaceId: string;
  sessionId: string;
  currentName: string;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  // Delete used to fire straight off the menu item. It now confirms, because
  // the sandbox does not come back and because a menu item has nowhere to show
  // the call it makes — the same reason the secrets tab confirms a delete.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const rename = useMutation({
    mutationFn: () => kortix.session(workspaceId, sessionId).update({ name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(workspaceId, sessionId) });
      invalidateSessions(qc, workspaceId);
      setRenaming(false);
      toast.success('Session renamed');
    },
    onError: () => toast.error('Could not rename'),
  });
  const restart = useMutation({
    mutationFn: () => kortix.session(workspaceId, sessionId).restart(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionStart(workspaceId, sessionId) });
      toast.success('Restarting the session…');
    },
    onError: () => toast.error('Could not restart'),
  });
  const remove = useMutation({
    mutationFn: () => kortix.session(workspaceId, sessionId).delete(),
    onSuccess: () => {
      invalidateSessions(qc, workspaceId);
      setConfirmingDelete(false);
      toast.success('Session deleted');
      router.push(`/workspaces/${workspaceId}`);
    },
    onError: () => toast.error('Could not delete'),
  });

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
          <DropdownMenuItem onClick={() => restart.mutate()} disabled={restart.isPending}>
            <RotateCw className="size-4" /> Restart
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmingDelete(true)}
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

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              The session and the sandbox behind it are destroyed. Restart instead if the runtime
              is just misbehaving — that keeps the sandbox and the transcript.
            </DialogDescription>
          </DialogHeader>
          {/* Both lifecycle calls, on the step where one of them is about to
              happen: the restart this dialog is recommending, and the delete
              the button performs. */}
          <CallSnippet id="session.delete" context={{ workspaceId, sessionId }} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Loading className="size-4" />}
              Delete session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
