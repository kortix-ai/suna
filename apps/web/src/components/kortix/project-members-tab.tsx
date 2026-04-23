'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

import {
  grantSandboxProjectAccess,
  listSandboxMembers,
  listSandboxProjectMembers,
  listSandboxes,
  revokeSandboxProjectAccess,
  type SandboxInfo,
  type SandboxMember,
  type SandboxProjectMember,
} from '@/lib/platform-client';
import { useServerStore } from '@/stores/server-store';
import { useCan } from '@/hooks/platform/use-can';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { EmptyState } from '@/components/ui/empty-state';
import { IconDelete, IconInvite, IconLoader, IconUsers } from '@/components/ui/kortix-icons';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserRow } from '@/components/ui/user-row';

interface Props {
  project: { id: string; name: string };
}

export function ProjectMembersTab({ project }: Props) {
  const activeInstanceId = useServerStore((s) =>
    s.servers.find((srv) => srv.id === s.activeServerId)?.instanceId ?? null,
  );

  const sandboxQuery = useQuery({
    queryKey: ['platform', 'sandbox-by-id', activeInstanceId],
    queryFn: async (): Promise<SandboxInfo | null> => {
      if (!activeInstanceId) return null;
      const all = await listSandboxes(activeInstanceId);
      return all.find((s) => s.sandbox_id === activeInstanceId) ?? null;
    },
    enabled: !!activeInstanceId,
    staleTime: 30_000,
  });

  const sandbox = sandboxQuery.data;
  const sandboxId = sandbox?.sandbox_id ?? null;
  const canManage = useCan(sandboxId, 'projects:access.manage');

  if (!sandbox) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-[13px] text-muted-foreground/60">
          {sandboxQuery.isLoading ? 'Loading instance…' : 'Instance not found'}
        </div>
      </div>
    );
  }

  if (!canManage.loading && !canManage.allowed) {
    return (
      <EmptyState
        icon={IconUsers}
        title="Not allowed here"
        description="You don't have permission to manage project access. Ask the instance owner to grant projects:access.manage."
      />
    );
  }

  return <ProjectMembersInner sandbox={sandbox} project={project} />;
}

function ProjectMembersInner({
  sandbox,
  project,
}: {
  sandbox: SandboxInfo;
  project: { id: string; name: string };
}) {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const sandboxMembersQuery = useQuery({
    queryKey: ['sandbox', 'members', sandbox.sandbox_id],
    queryFn: () => listSandboxMembers(sandbox.sandbox_id),
  });

  const membersQuery = useQuery({
    queryKey: ['sandbox', 'project-members', sandbox.sandbox_id, project.id],
    queryFn: () => listSandboxProjectMembers(sandbox, project.id),
  });

  const sandboxMembers = sandboxMembersQuery.data?.members ?? [];
  const emailByUser = useMemo(
    () => new Map(sandboxMembers.map((m) => [m.user_id, m.email])),
    [sandboxMembers],
  );

  const grantedIds = useMemo(
    () => new Set((membersQuery.data?.members ?? []).map((m) => m.user_id)),
    [membersQuery.data],
  );

  const candidates = useMemo<SandboxMember[]>(
    () =>
      sandboxMembers.filter(
        (m) => !grantedIds.has(m.user_id) && m.role !== 'owner',
      ),
    [sandboxMembers, grantedIds],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: ['sandbox', 'project-members', sandbox.sandbox_id, project.id],
    });
  };

  const grantMutation = useMutation({
    mutationFn: (input: { userId: string; role: 'admin' | 'member' }) =>
      grantSandboxProjectAccess(sandbox, project.id, input.userId, input.role),
    onSuccess: () => {
      sonnerToast.success('Added to project');
      setPickerOpen(false);
      invalidate();
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to add');
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) =>
      revokeSandboxProjectAccess(sandbox, project.id, userId),
    onSuccess: () => {
      sonnerToast.success('Removed from project');
      invalidate();
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to remove');
    },
  });

  const memberRows = membersQuery.data?.members ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-10 py-8 space-y-6">
        <header className="flex items-center justify-between gap-4">
          <div>
            <div className="text-muted-foreground/60 text-[11px] font-semibold uppercase tracking-[0.08em]">
              Members · {memberRows.length}
            </div>
            <p className="text-muted-foreground mt-1 text-[12px]">
              People explicitly granted access to <span className="text-foreground">{project.name}</span>.
            </p>
          </div>
          {candidates.length > 0 ? (
            <AddPersonButton
              candidates={candidates}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onPick={(userId, role) => grantMutation.mutate({ userId, role })}
              pending={grantMutation.isPending}
            />
          ) : null}
        </header>

        {membersQuery.isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <IconLoader className="h-4 w-4 animate-spin" /> Loading members…
          </div>
        ) : memberRows.length === 0 ? (
          <div className="border-border/60 bg-muted/20 text-muted-foreground rounded-xl border border-dashed px-4 py-8 text-center text-sm">
            Just you. Add teammates to let them see this project.
          </div>
        ) : (
          <div className="space-y-1.5">
            {memberRows.map((m) => (
              <ProjectMemberRow
                key={m.user_id}
                member={m}
                email={emailByUser.get(m.user_id) ?? null}
                onRevoke={() => revokeMutation.mutate(m.user_id)}
                pending={
                  revokeMutation.isPending &&
                  revokeMutation.variables === m.user_id
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectMemberRow({
  member,
  email,
  onRevoke,
  pending,
}: {
  member: SandboxProjectMember;
  email: string | null;
  onRevoke: () => void;
  pending: boolean;
}) {
  const identity = email || member.user_id;
  return (
    <UserRow
      email={identity}
      trailing={
        <>
          <Badge
            variant={member.role === 'admin' ? 'info' : 'muted'}
            size="sm"
            className="uppercase tracking-wide"
          >
            {member.role}
          </Badge>
          <Button
            size="icon"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive h-7 w-7"
            onClick={onRevoke}
            disabled={pending}
            aria-label="Remove from project"
          >
            {pending ? (
              <IconLoader className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <IconDelete className="h-3.5 w-3.5" />
            )}
          </Button>
        </>
      }
    />
  );
}

function AddPersonButton({
  candidates,
  open,
  onOpenChange,
  onPick,
  pending,
}: {
  candidates: SandboxMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (userId: string, role: 'admin' | 'member') => void;
  pending: boolean;
}) {
  return (
    <CommandPopover open={open} onOpenChange={onOpenChange}>
      <CommandPopoverTrigger>
        <Button size="sm" disabled={pending} className="shrink-0">
          {pending ? (
            <IconLoader className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <IconInvite className="mr-1.5 h-3.5 w-3.5" />
              Add teammate
            </>
          )}
        </Button>
      </CommandPopoverTrigger>
      <CommandPopoverContent side="bottom" align="end" shouldFilter>
        <CommandInput placeholder="Find a teammate…" />
        <CommandList>
          <CommandEmpty className="px-4 py-6 text-center text-xs">
            No matches.
          </CommandEmpty>
          <CommandGroup>
            {candidates.map((c) => {
              const label = c.email || c.user_id;
              return (
                <CommandItem
                  key={c.user_id}
                  value={label}
                  onSelect={() =>
                    onPick(c.user_id, c.role === 'admin' ? 'admin' : 'member')
                  }
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
                >
                  <UserAvatar email={label} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate text-xs font-medium">
                      {label}
                    </div>
                    {c.role ? (
                      <div className="text-muted-foreground/70 text-[10px] uppercase tracking-wide">
                        {c.role}
                      </div>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}
