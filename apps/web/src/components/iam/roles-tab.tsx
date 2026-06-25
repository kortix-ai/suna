'use client';

// Roles tab on the account page. Two stacked sections: a Roles list with a
// capability-matrix create/edit dialog (custom roles deactivate capabilities
// by omitting permissions), and the PolicyAssignments surface below it.
//
// Built-in roles are read-only; only custom (is_system === false) roles can be
// edited or deleted, and only when canManage is true. The capability matrix
// filters the action catalog to the selected role's resource_type and groups
// the actions by their capability prefix for readability.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  type ActionCatalogEntry,
  type IamRole,
  type ResourceType,
  createRole,
  deleteRole,
  getRolePermissions,
  getRoleUsage,
  listActions,
  listRoles,
  updateRole,
  updateRolePermissions,
} from '@/lib/iam-client';

import { PolicyAssignments } from './policy-assignments';

interface RolesTabProps {
  accountId: string;
  canManage: boolean;
}

export function RolesTab({ accountId, canManage }: RolesTabProps) {
  return (
    <div className="space-y-6">
      <RolesSection accountId={accountId} canManage={canManage} />
      <PolicyAssignments accountId={accountId} canManage={canManage} />
    </div>
  );
}

// ─── Roles list ────────────────────────────────────────────────────────────

function RolesSection({ accountId, canManage }: RolesTabProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<IamRole | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IamRole | null>(null);

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 30_000,
  });

  const roles = rolesQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Roles</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Custom roles deactivate capabilities by omitting their permissions.
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              New role
            </Button>
          )}
        </div>
      </header>

      <div className="px-6 py-4">
        {rolesQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : roles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No roles yet. Create a custom role to scope what a principal can do.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Type</th>
                <th className="py-2 font-medium">Origin</th>
                <th className="py-2 font-medium">Used by</th>
                <th className="w-28 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {roles.map((role) => (
                <RoleRow
                  key={role.role_id}
                  accountId={accountId}
                  role={role}
                  canManage={canManage}
                  onEdit={() => setEditTarget(role)}
                  onDelete={() => setDeleteTarget(role)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <RoleDialog
          accountId={accountId}
          mode="create"
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {editTarget && (
        <RoleDialog
          accountId={accountId}
          mode="edit"
          role={editTarget}
          open={!!editTarget}
          onOpenChange={(o) => {
            if (!o) setEditTarget(null);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteRoleConfirm
          accountId={accountId}
          role={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}

function RoleRow({
  accountId,
  role,
  canManage,
  onEdit,
  onDelete,
}: {
  accountId: string;
  role: IamRole;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isCustom = !role.is_system;

  const usageQuery = useQuery({
    queryKey: ['iam-role-usage', accountId, role.role_id],
    queryFn: () => getRoleUsage(accountId, role.role_id),
    staleTime: 30_000,
    enabled: isCustom,
  });

  return (
    <tr className="hover:bg-muted/20">
      <td className="py-2">
        <div className="font-medium text-foreground">{role.name}</div>
        <div className="font-mono text-[10px] text-muted-foreground">{role.key}</div>
        {role.description && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{role.description}</div>
        )}
      </td>
      <td className="py-2">
        <Badge variant="outline" size="sm" className="font-normal capitalize">
          {role.resource_type}
        </Badge>
      </td>
      <td className="py-2">
        <Badge variant={role.is_system ? 'muted' : 'outline'} size="sm" className="font-normal">
          {role.is_system ? 'Built-in' : 'Custom'}
        </Badge>
      </td>
      <td className="py-2 text-xs text-muted-foreground">
        {!isCustom ? '—' : usageQuery.isLoading ? '…' : (usageQuery.data?.policy_count ?? 0)}
      </td>
      <td className="py-2 text-right">
        {isCustom && canManage && (
          <div className="flex justify-end gap-1.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={onEdit}
              aria-label="Edit"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── Create / edit dialog (capability matrix) ───────────────────────────────

const KEY_RE = /^[a-z0-9_]{2,64}$/;

function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function RoleDialog({
  accountId,
  mode,
  role,
  open,
  onOpenChange,
}: {
  accountId: string;
  mode: 'create' | 'edit';
  role?: IamRole;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = mode === 'edit' && !!role;

  const [name, setName] = useState(role?.name ?? '');
  const [keyValue, setKeyValue] = useState(role?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(isEdit);
  const [description, setDescription] = useState(role?.description ?? '');
  const [resourceType, setResourceType] = useState<ResourceType>(
    role?.resource_type ?? 'project',
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const actionsQuery = useQuery({
    queryKey: ['iam-actions', accountId],
    queryFn: () => listActions(accountId),
    staleTime: 30_000,
  });

  // Pre-fill the matrix selection for an edit.
  const permsQuery = useQuery({
    queryKey: ['iam-role-permissions', accountId, role?.role_id],
    queryFn: () => getRolePermissions(accountId, role!.role_id),
    staleTime: 30_000,
    enabled: isEdit,
  });

  // Seed selected from loaded permissions once (edit mode).
  const [seeded, setSeeded] = useState(false);
  if (isEdit && !seeded && permsQuery.data) {
    setSelected(new Set(permsQuery.data.actions));
    setSeeded(true);
  }

  const matrixActions = useMemo(
    () => (actionsQuery.data ?? []).filter((a) => a.resource_type === resourceType),
    [actionsQuery.data, resourceType],
  );

  const groups = useMemo(() => groupActions(matrixActions), [matrixActions]);

  const keyValid = KEY_RE.test(keyValue);
  const nameValid = name.trim().length > 0;

  function handleNameChange(value: string) {
    setName(value);
    if (!isEdit && !keyTouched) {
      setKeyValue(slugifyKey(value));
    }
  }

  function toggle(action: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createRole(accountId, {
        key: keyValue,
        name: name.trim(),
        description: description.trim() || undefined,
        resourceType,
        actions: [...selected],
      }),
    onSuccess: () => {
      toast.success('Role created');
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create role'),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const nameChanged = name.trim() !== role!.name;
      const descChanged = (description.trim() || null) !== (role!.description ?? null);
      if (nameChanged || descChanged) {
        await updateRole(accountId, role!.role_id, {
          name: name.trim(),
          description: description.trim() || null,
        });
      }
      await updateRolePermissions(accountId, role!.role_id, [...selected]);
    },
    onSuccess: () => {
      toast.success('Role updated');
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      queryClient.invalidateQueries({
        queryKey: ['iam-role-permissions', accountId, role!.role_id],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update role'),
  });

  const mutation = isEdit ? updateMutation : createMutation;
  const isPending = mutation.isPending;
  const matrixLoading = actionsQuery.isLoading || (isEdit && permsQuery.isLoading);

  const submitDisabled =
    isPending || !nameValid || (!isEdit && !keyValid) || matrixLoading;

  return (
    <Dialog open={open} onOpenChange={(o) => !isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit role' : 'New role'}</DialogTitle>
          <DialogDescription>
            Pick the capabilities this role grants. Anything left unchecked is deactivated for
            principals assigned this role.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Deploy operator"
                disabled={isPending}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>Key</Label>
              <Input
                value={keyValue}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKeyValue(e.target.value);
                }}
                placeholder="deploy_operator"
                disabled={isPending || isEdit}
                className="font-mono"
              />
              {!isEdit && keyValue.length > 0 && !keyValid && (
                <p className="text-[11px] text-destructive">
                  Lowercase letters, digits and underscores, 2–64 chars.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for"
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Applies to</Label>
            <Select
              value={resourceType}
              onValueChange={(v) => {
                setResourceType(v as ResourceType);
                if (!isEdit) setSelected(new Set());
              }}
              disabled={isPending || isEdit}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">Project</SelectItem>
                <SelectItem value="account">Account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Capabilities</Label>
            <div className="max-h-64 space-y-4 overflow-y-auto rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
              {matrixLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : matrixActions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No capabilities are available for this scope.
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.label} className="space-y-1.5">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {group.entries.map((entry) => (
                        <label
                          key={entry.action}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 text-sm text-foreground',
                            isPending && 'pointer-events-none opacity-60',
                          )}
                        >
                          <Checkbox
                            checked={selected.has(entry.action)}
                            onCheckedChange={(c) => toggle(entry.action, c === true)}
                            disabled={isPending}
                          />
                          <span>{entry.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {selected.size} selected
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={submitDisabled}
            className="gap-1.5"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete ─────────────────────────────────────────────────────────────────

function DeleteRoleConfirm({
  accountId,
  role,
  onClose,
}: {
  accountId: string;
  role: IamRole;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const usageQuery = useQuery({
    queryKey: ['iam-role-usage', accountId, role.role_id],
    queryFn: () => getRoleUsage(accountId, role.role_id),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(accountId, role.role_id),
    onSuccess: () => {
      toast.success('Role deleted');
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete role'),
  });

  const count = usageQuery.data?.policy_count ?? 0;
  const policies = count === 1 ? 'policy' : 'policies';

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Delete role"
      description={`This role is used by ${count} ${policies}. Deleting it removes those assignments.`}
      confirmLabel="Delete"
      confirmVariant="destructive"
      isPending={deleteMutation.isPending}
      onConfirm={() => deleteMutation.mutate()}
    />
  );
}

// ─── Capability grouping ────────────────────────────────────────────────────

interface ActionGroup {
  label: string;
  entries: ActionCatalogEntry[];
}

/**
 * Group catalog entries by their capability prefix for readability. Actions
 * are dot-namespaced (e.g. project.gitops.push, project.schedule.create); we
 * key on the middle segment (the capability), falling back to the leading
 * segment for two-part actions. The group label is humanized from that segment.
 */
function groupActions(entries: ActionCatalogEntry[]): ActionGroup[] {
  const byKey = new Map<string, ActionGroup>();
  for (const entry of entries) {
    const segments = entry.action.split('.');
    const key = segments.length >= 3 ? segments[1] : segments[0];
    let group = byKey.get(key);
    if (!group) {
      group = { label: humanizeSegment(key), entries: [] };
      byKey.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function humanizeSegment(segment: string): string {
  const special: Record<string, string> = {
    gitops: 'Git Ops',
    schedule: 'Schedules',
    iam: 'IAM',
  };
  if (special[segment]) return special[segment];
  return segment
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
