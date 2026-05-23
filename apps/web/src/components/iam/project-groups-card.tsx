'use client';

// Project groups on the Settings tab. Bundle multiple projects under one
// name; policies attach via scope_type='project_group' (engine resolves
// "is target project in the group?" at match time).

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, Loader2, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type ProjectGroup,
  addProjectsToGroup,
  createProjectGroupApi,
  deleteProjectGroupApi,
  listProjectGroupMembers,
  listProjectGroups,
  removeProjectFromGroup,
} from '@/lib/iam-client';
import { listProjectsForAccount } from '@/lib/projects-client';

interface ProjectGroupsCardProps {
  accountId: string;
  canManage: boolean;
}

export function ProjectGroupsCard({ accountId, canManage }: ProjectGroupsCardProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [manageGroup, setManageGroup] = useState<ProjectGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectGroup | null>(null);

  const groupsQuery = useQuery({
    queryKey: ['project-groups', accountId],
    queryFn: () => listProjectGroups(accountId),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (groupId: string) => deleteProjectGroupApi(accountId, groupId),
    onSuccess: () => {
      toast.success('Project group removed');
      queryClient.invalidateQueries({ queryKey: ['project-groups', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete group'),
  });

  const groups = groupsQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <FolderTree className="h-4 w-4 text-muted-foreground" />
              Project groups
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bundle projects so one policy covers many — e.g. &ldquo;Mobile editors
              get Editor role on every project in the Mobile group&rdquo;. Pick the
              group as the scope when creating a policy.
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              New group
            </Button>
          )}
        </div>
      </header>

      <div className="px-6 py-4">
        {groupsQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No project groups yet. Create one, attach projects, then use it as a
            scope in any policy.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="py-2 font-medium">Group</th>
                <th className="py-2 font-medium">Projects</th>
                <th className="w-32 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {groups.map((g) => (
                <tr key={g.group_id} className="hover:bg-muted/20">
                  <td className="py-2">
                    <div className="font-medium text-foreground">{g.name}</div>
                    {g.description && (
                      <div className="text-[11px] text-muted-foreground">
                        {g.description}
                      </div>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge variant="outline" size="sm">
                      {g.project_count}{' '}
                      {g.project_count === 1 ? 'project' : 'projects'}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setManageGroup(g)}
                        >
                          Manage
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(g)}
                          aria-label="Delete group"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CreateGroupDialog
        accountId={accountId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['project-groups', accountId] })}
      />

      {manageGroup && (
        <ManageGroupProjectsDialog
          accountId={accountId}
          group={manageGroup}
          open={!!manageGroup}
          onOpenChange={(o) => {
            if (!o) setManageGroup(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete project group?"
        description={
          deleteTarget
            ? `"${deleteTarget.name}" will be removed. Any policies scoped to this group will stop matching its projects (those projects still keep their individual policies).`
            : ''
        }
        confirmLabel="Delete group"
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.group_id);
        }}
      />
    </section>
  );
}

// ─── Create dialog ─────────────────────────────────────────────────────────

function CreateGroupDialog({
  accountId,
  open,
  onOpenChange,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createProjectGroupApi(accountId, {
        name: name.trim(),
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Project group created');
      onCreated();
      setName('');
      setDescription('');
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create group'),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project group</DialogTitle>
          <DialogDescription>
            Choose a short, descriptive name. You&apos;ll add projects to the
            group next.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mobile production"
              autoFocus
              disabled={mutation.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Customer-facing mobile apps"
              disabled={mutation.isPending}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Manage dialog (add/remove projects) ───────────────────────────────────

function ManageGroupProjectsDialog({
  accountId,
  group,
  open,
  onOpenChange,
}: {
  accountId: string;
  group: ProjectGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ['projects-for-account', accountId],
    queryFn: () => listProjectsForAccount(accountId),
    enabled: open,
    staleTime: 30_000,
  });

  const membersQuery = useQuery({
    queryKey: ['project-group-members', accountId, group.group_id],
    queryFn: () => listProjectGroupMembers(accountId, group.group_id),
    enabled: open,
    staleTime: 15_000,
  });

  const memberIds = useMemo(
    () => new Set((membersQuery.data ?? []).map((m) => m.project_id)),
    [membersQuery.data],
  );

  const addMutation = useMutation({
    mutationFn: (projectIds: string[]) =>
      addProjectsToGroup(accountId, group.group_id, projectIds),
    onSuccess: (res) => {
      if (res.added > 0) toast.success(`Added ${res.added} project${res.added === 1 ? '' : 's'}`);
      queryClient.invalidateQueries({
        queryKey: ['project-group-members', accountId, group.group_id],
      });
      queryClient.invalidateQueries({ queryKey: ['project-groups', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to add projects'),
  });

  const removeMutation = useMutation({
    mutationFn: (projectId: string) =>
      removeProjectFromGroup(accountId, group.group_id, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['project-group-members', accountId, group.group_id],
      });
      queryClient.invalidateQueries({ queryKey: ['project-groups', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove project'),
  });

  const projects = projectsQuery.data ?? [];
  const candidates = projects.filter((p) => !memberIds.has(p.project_id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{group.name}</DialogTitle>
          <DialogDescription>
            Projects in this group are covered by any policy scoped to it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              In this group ({membersQuery.data?.length ?? 0})
            </h3>
            {membersQuery.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : (membersQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No projects yet.</p>
            ) : (
              <ul className="space-y-1">
                {(membersQuery.data ?? []).map((m) => (
                  <li
                    key={m.project_id}
                    className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5 text-sm"
                  >
                    <span className="text-foreground">{m.project_name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => removeMutation.mutate(m.project_id)}
                      disabled={removeMutation.isPending}
                      aria-label="Remove from group"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Add projects ({candidates.length} available)
            </h3>
            {projectsQuery.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Every project in this account is already in the group.
              </p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {candidates.map((p) => (
                  <li
                    key={p.project_id}
                    className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5 text-sm"
                  >
                    <span className="text-foreground">{p.name}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addMutation.mutate([p.project_id])}
                      disabled={addMutation.isPending}
                      className="gap-1"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
