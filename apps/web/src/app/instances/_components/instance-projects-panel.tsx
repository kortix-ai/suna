'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

import {
  grantSandboxProjectAccess,
  listSandboxMembers,
  listSandboxProjectMembers,
  listSandboxProjects,
  revokeSandboxProjectAccess,
  type SandboxInfo,
  type SandboxMember,
  type SandboxProjectMember,
  type SandboxProjectSummary,
} from '@/lib/platform-client';
import { cn } from '@/lib/utils';
import { AvatarStack } from '@/components/ui/avatar-stack';
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
import {
  IconBack,
  IconChevronRight,
  IconDelete,
  IconFolder,
  IconInvite,
  IconLoader,
  IconProject,
} from '@/components/ui/kortix-icons';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserRow } from '@/components/ui/user-row';
import { useCan } from '@/hooks/platform/use-can';

/**
 * Projects tab inside the sandbox settings modal. Owner-only.
 *
 * Two views that drill in-place (no nested modal). The tab swaps between:
 *   - a project list (with avatar-stacks showing who's on each project)
 *   - a per-project members panel with a back button + autocomplete
 *
 * All project-ACL mutations go to kortix-master inside the sandbox via the
 * preview proxy — the ACL table lives in that sqlite database (co-located
 * with the projects themselves). Emails aren't known inside the sandbox;
 * we join against the sandbox-level member list for display.
 */
export function InstanceProjectsPanel({
  sandbox,
}: {
  sandbox: SandboxInfo;
  canManage?: boolean;
}) {
  const canManageAccess = useCan(sandbox.sandbox_id, 'projects:access.manage').allowed;

  const projectsQuery = useQuery({
    queryKey: ['sandbox', 'projects', sandbox.sandbox_id],
    queryFn: () => listSandboxProjects(sandbox),
    staleTime: 15_000,
    retry: false,
  });

  const sandboxMembersQuery = useQuery({
    queryKey: ['sandbox', 'members', sandbox.sandbox_id],
    queryFn: () => listSandboxMembers(sandbox.sandbox_id),
  });

  const [selected, setSelected] = useState<SandboxProjectSummary | null>(null);

  const sandboxMembers = sandboxMembersQuery.data?.members ?? [];
  const emailByUser = useMemo(
    () => new Map(sandboxMembers.map((m) => [m.user_id, m.email])),
    [sandboxMembers],
  );

  if (!canManageAccess) {
    return (
      <EmptyState
        icon={IconProject}
        title="Not allowed here"
        description="You don't have permission to manage per-project access. Ask the instance owner to grant projects:access.manage."
      />
    );
  }

  if (selected) {
    return (
      <ManageProjectView
        sandbox={sandbox}
        project={selected}
        sandboxMembers={sandboxMembers}
        emailByUser={emailByUser}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          You see every project in this instance. Teammates only see the
          projects you add them to.
        </p>
      </header>

      {projectsQuery.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <IconLoader className="h-4 w-4 animate-spin" /> Loading projects…
        </div>
      ) : projectsQuery.error ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          {projectsQuery.error instanceof Error
            ? projectsQuery.error.message
            : 'Failed to load projects.'}
        </div>
      ) : (projectsQuery.data ?? []).length === 0 ? (
        <EmptyState
          icon={IconFolder}
          title="No projects yet"
          description="Projects appear here once you create them inside the workspace."
        />
      ) : (
        <div className="space-y-1.5">
          {(projectsQuery.data ?? []).map((project) => (
            <ProjectRow
              key={project.id}
              sandbox={sandbox}
              project={project}
              emailByUser={emailByUser}
              onOpen={() => setSelected(project)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Project list row
// ──────────────────────────────────────────────────────────────────────────────

function ProjectRow({
  sandbox,
  project,
  emailByUser,
  onOpen,
}: {
  sandbox: SandboxInfo;
  project: SandboxProjectSummary;
  emailByUser: Map<string, string | null>;
  onOpen: () => void;
}) {
  const aclQuery = useQuery({
    queryKey: ['sandbox', 'project-members', sandbox.sandbox_id, project.id],
    queryFn: () => listSandboxProjectMembers(sandbox, project.id),
    staleTime: 10_000,
  });

  const members = aclQuery.data?.members ?? [];
  const people = useMemo(
    () =>
      members
        .map((m) => ({ email: emailByUser.get(m.user_id) || m.user_id }))
        .filter((p): p is { email: string } => Boolean(p.email)),
    [members, emailByUser],
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
        'border-border/60 bg-muted/30 hover:bg-muted/50',
      )}
    >
      <div className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg border">
        <IconFolder className="h-4 w-4" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">
          {project.name || project.id}
        </div>
        <div className="text-muted-foreground/70 truncate font-mono text-[11px]">
          {project.path || project.id}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {people.length > 0 ? (
          <AvatarStack people={people} max={3} size="sm" />
        ) : (
          <span className="text-muted-foreground/70 text-[11px] italic">
            Owner only
          </span>
        )}
        <IconChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground h-4 w-4 transition-colors" />
      </div>
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Project detail view (members + add)
// ──────────────────────────────────────────────────────────────────────────────

function ManageProjectView({
  sandbox,
  project,
  sandboxMembers,
  emailByUser,
  onBack,
}: {
  sandbox: SandboxInfo;
  project: SandboxProjectSummary;
  sandboxMembers: SandboxMember[];
  emailByUser: Map<string, string | null>;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['sandbox', 'project-members', sandbox.sandbox_id, project.id],
    queryFn: () => listSandboxProjectMembers(sandbox, project.id),
  });

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
    <div className="space-y-6 p-6">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
        >
          <IconBack className="h-3.5 w-3.5" />
          All projects
        </button>
      </div>

      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-muted/60 text-foreground flex size-11 shrink-0 items-center justify-center rounded-xl border">
            <IconFolder className="h-5 w-5" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <h2 className="text-foreground truncate text-lg font-semibold tracking-tight">
              {project.name || project.id}
            </h2>
            <div className="text-muted-foreground/70 mt-0.5 truncate font-mono text-[11px]">
              {project.path || project.id}
            </div>
          </div>
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

      <section className="space-y-3">
        <div className="text-muted-foreground/60 text-[11px] font-semibold uppercase tracking-[0.08em]">
          Members · {memberRows.length}
        </div>
        {membersQuery.isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <IconLoader className="h-4 w-4 animate-spin" /> Loading…
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
      </section>
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
          <RoleTag role={member.role} />
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

// ──────────────────────────────────────────────────────────────────────────────
// Add-person button + picker
// ──────────────────────────────────────────────────────────────────────────────

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
              <IconInvite className="h-3.5 w-3.5" />
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
                    onPick(
                      c.user_id,
                      c.role === 'admin' ? 'admin' : 'member',
                    )
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

function RoleTag({ role }: { role: 'owner' | 'admin' | 'member' }) {
  const variant: 'info' | 'muted' = role === 'admin' ? 'info' : 'muted';
  return (
    <Badge variant={variant} size="sm" className="uppercase tracking-wide">
      {role}
    </Badge>
  );
}
