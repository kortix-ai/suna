'use client';

import { CallSnippet } from '@/components/dev/call-snippet';
import { useMatter } from '@/components/access';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { Input } from '@kortix/ui/input';
import { kortix } from '@/lib/kortix';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { isRuntimeReady } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@kortix/ui';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ArrowClockwiseIcon, DotsThreeVerticalIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';

export function SessionHeader({
  projectId,
  sessionId,
  runtimeReady,
}: {
  projectId: string;
  sessionId: string;
  /** `useSession(...).phase === 'ready'`: the status badge refetches when the runtime comes up. */
  runtimeReady?: boolean;
}) {
  const qc = useQueryClient();
  // The row is read once while the sandbox provisions; without this the badge
  // keeps saying "Provisioning" until a reload.
  useEffect(() => {
    if (runtimeReady) void qc.invalidateQueries({ queryKey: qk.session(projectId, sessionId) });
  }, [runtimeReady, qc, projectId, sessionId]);
  const session = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).get({ showErrors: false }),
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
          ready ? 'bg-kortix-green' : health.data ? 'bg-kortix-orange' : 'bg-muted-foreground/40',
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
      <SessionActions projectId={projectId} sessionId={sessionId} currentName={title} />
    </header>
  );
}

/** Session lifecycle actions: rename (update), restart, delete. */
function SessionActions({
  projectId,
  sessionId,
  currentName,
}: {
  projectId: string;
  sessionId: string;
  currentName: string;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const matterId = useMatter().matter._id;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  // Delete used to fire straight off the menu item. It now confirms, because
  // the sandbox does not come back and because a menu item has nowhere to show
  // the call it makes — the same reason the secrets tab confirms a delete.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const rename = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).update({ name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(projectId, sessionId) });
      invalidateSessions(qc, projectId);
      setRenaming(false);
      successToast('Thread renamed');
    },
    onError: () => errorToast('Could not rename'),
  });
  const restart = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).restart(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionStart(projectId, sessionId) });
      successToast('Restarting the thread…');
    },
    onError: () => errorToast('Could not restart'),
  });
  const remove = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).delete(),
    onSuccess: () => {
      // Leave first: the session page would refetch a session that is gone
      // and show its error state. `replace`, so Back does not return to it.
      router.replace(`/app/matters/${matterId}/assistant`);
      setConfirmingDelete(false);
      successToast('Thread deleted');
    },
    onError: () => errorToast('Could not delete'),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Thread actions">
            <DotsThreeVerticalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setName(currentName);
              setRenaming(true);
            }}
          >
            <PencilSimpleIcon className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => restart.mutate()} disabled={restart.isPending}>
            <ArrowClockwiseIcon className="size-4" /> Restart
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmingDelete(true)}
            disabled={remove.isPending}
          >
            <TrashIcon className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal open={renaming} onOpenChange={setRenaming}>
        <ModalContent>
          <ModalHeader>
            <ModalTitle>Rename thread</ModalTitle>
          </ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && rename.mutate()}
            />
          </ModalBody>
          <ModalFooter>
            <Button disabled={!name.trim() || rename.isPending} onClick={() => rename.mutate()}>
              Save
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this thread?"
        description={
          <div className="space-y-3">
            <p>
              The thread, its conversation and its sandbox are deleted. If the agent is stuck,
              restart the thread instead: that keeps the conversation and the files.
            </p>
            {/* Both lifecycle calls, on the step where one of them is about to
                happen: the restart this dialog is recommending, and the delete
                the button performs. */}
            <CallSnippet id="session.delete" context={{ projectId, sessionId }} />
          </div>
        }
        confirmLabel="Delete thread"
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
