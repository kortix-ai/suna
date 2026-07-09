'use client';

// Roles tab on the account page. Two stacked sections: a Roles list with a
// capability-matrix create/edit dialog (custom roles deactivate capabilities
// by omitting permissions), and the PolicyAssignments surface below it.
//
// Built-in roles are read-only; only custom (is_system === false) roles can be
// edited or deleted, and only when canManage is true. Built-ins can be
// duplicated into a new custom role as a starting point. The capability matrix
// filters the action catalog to the selected role's resource_type and groups
// the actions by their capability prefix for readability.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, Lock, Pencil, Plus, Search, Shield, Trash2 } from 'lucide-react';
import Link from 'next/link';

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
import { EmptyState } from '@/features/layout/section/empty-state';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
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

// Same wording the backend's requireEntitlement('rbac') 402 uses — keep it in
// sync with apps/api/src/accounts/iam/helpers.ts ENTITLEMENT_LABEL.rbac.
const RBAC_UPSELL_MESSAGE =
  'Custom roles, policies, and groups are available on the Enterprise plan. Contact sales to enable it.';

interface RolesTabProps {
  accountId: string;
  canManage: boolean;
  /** Whether the account's tier carries the `rbac` entitlement. Creating or
   * editing custom roles and policy assignments is gated on it server-side
   * (deleting is not — cleanup is always allowed), so those actions are
   * disabled here rather than left to fail with a 402 on submit. */
  rbacEnabled: boolean;
}

/** Prefill payload for opening the create dialog seeded from a built-in role. */
interface RolePrefill {
  name: string;
  resourceType: ResourceType;
  actions: string[];
}

export function RolesTab({ accountId, canManage, rbacEnabled }: RolesTabProps) {
  return (
    <div className="space-y-6">
      {canManage && !rbacEnabled && (
        <InfoBanner
          tone="info"
          title="Enterprise feature"
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/enterprise">Contact sales</Link>
            </Button>
          }
        >
          {RBAC_UPSELL_MESSAGE}
        </InfoBanner>
      )}
      <RolesSection accountId={accountId} canManage={canManage} rbacEnabled={rbacEnabled} />
      <PolicyAssignments accountId={accountId} canManage={canManage} rbacEnabled={rbacEnabled} />
    </div>
  );
}

// ─── Roles list ────────────────────────────────────────────────────────────

function RolesSection({ accountId, canManage, rbacEnabled }: RolesTabProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<RolePrefill | null>(null);
  const [editTarget, setEditTarget] = useState<IamRole | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IamRole | null>(null);

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 30_000,
  });

  const roles = rolesQuery.data ?? [];

  function openCreate(prefill: RolePrefill | null) {
    setCreatePrefill(prefill);
    setCreateOpen(true);
  }

  const newRoleButton = canManage && (
    rbacEnabled ? (
      <Button size="sm" onClick={() => openCreate(null)} className="gap-1.5">
        <Plus className="h-4 w-4" />
        New role
      </Button>
    ) : (
      <Hint label={RBAC_UPSELL_MESSAGE} side="top" className="max-w-xs">
        <span className="inline-flex items-center gap-1.5">
          <Button size="sm" className="gap-1.5" disabled>
            <Plus className="h-4 w-4" />
            New role
          </Button>
          <Badge variant="outline" size="sm">
            Enterprise
          </Badge>
        </span>
      </Hint>
    )
  );

  return (
    <SectionCard
      title="Roles"
      description="Custom roles deactivate capabilities by omitting their permissions."
      action={newRoleButton}
      flush
    >
      {rolesQuery.isError ? (
        <div className="px-6 py-5">
          <InfoBanner
            tone="destructive"
            title="Failed to load roles"
            action={
              <Button variant="outline" size="sm" onClick={() => rolesQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(rolesQuery.error as Error)?.message}
          </InfoBanner>
        </div>
      ) : rolesQuery.isLoading ? (
        <div className="px-6 py-4">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : roles.length === 0 ? (
        <EmptyState
          icon={Shield}
          title="No roles yet"
          description="Create a custom role to scope what a member, group, or agent can do."
          action={newRoleButton}
        />
      ) : (
        <div className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Type</th>
                <th className="px-3 py-2.5 font-medium">Origin</th>
                <th className="px-3 py-2.5 font-medium">Used by</th>
                <th className="w-28 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {roles.map((role) => (
                <RoleRow
                  key={role.role_id}
                  accountId={accountId}
                  role={role}
                  canManage={canManage}
                  rbacEnabled={rbacEnabled}
                  onEdit={() => setEditTarget(role)}
                  onDelete={() => setDeleteTarget(role)}
                  onDuplicate={(prefill) => openCreate(prefill)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <RoleDialog
          accountId={accountId}
          mode="create"
          prefill={createPrefill}
          open={createOpen}
          onOpenChange={(o) => {
            setCreateOpen(o);
            if (!o) setCreatePrefill(null);
          }}
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
    </SectionCard>
  );
}

function RoleRow({
  accountId,
  role,
  canManage,
  rbacEnabled,
  onEdit,
  onDelete,
  onDuplicate,
}: {
  accountId: string;
  role: IamRole;
  canManage: boolean;
  rbacEnabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: (prefill: RolePrefill) => void;
}) {
  const isCustom = !role.is_system;
  const queryClient = useQueryClient();
  const [duplicating, setDuplicating] = useState(false);

  const usageQuery = useQuery({
    queryKey: ['iam-role-usage', accountId, role.role_id],
    queryFn: () => getRoleUsage(accountId, role.role_id),
    staleTime: 30_000,
    enabled: isCustom,
  });

  async function handleDuplicate() {
    setDuplicating(true);
    try {
      const perms = await queryClient.fetchQuery({
        queryKey: ['iam-role-permissions', accountId, role.role_id],
        queryFn: () => getRolePermissions(accountId, role.role_id),
        staleTime: 30_000,
      });
      onDuplicate({
        name: `${role.name} copy`,
        resourceType: role.resource_type,
        actions: perms.actions,
      });
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to load role permissions');
    } finally {
      setDuplicating(false);
    }
  }

  return (
    <tr className="hover:bg-muted/20">
      <td className="px-6 py-2">
        <div className="font-medium text-foreground">{role.name}</div>
        <div className="font-mono text-xs text-muted-foreground">{role.key}</div>
        {role.description && (
          <div className="mt-0.5 text-xs text-muted-foreground">{role.description}</div>
        )}
      </td>
      <td className="px-3 py-2">
        <Badge variant="outline" size="sm" className="font-normal capitalize">
          {role.resource_type}
        </Badge>
      </td>
      <td className="px-3 py-2">
        {role.is_system ? (
          <Hint label="Built-in roles are managed by Kortix and can't be edited or deleted. Duplicate one to start a custom role." side="top">
            <span className="inline-flex">
              <Badge variant="muted" size="sm" className="gap-1 font-normal">
                <Lock className="h-3 w-3" />
                Built-in
              </Badge>
            </span>
          </Hint>
        ) : (
          <Badge variant="outline" size="sm" className="font-normal">
            Custom
          </Badge>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {!isCustom
          ? '—'
          : usageQuery.isError
            ? '—'
            : usageQuery.isLoading
              ? '…'
              : (usageQuery.data?.policy_count ?? 0)}
      </td>
      <td className="px-3 py-2 text-right">
        {canManage && (
          <div className="flex justify-end gap-1.5">
            {isCustom ? (
              <>
                <Hint
                  label={rbacEnabled ? `Edit role ${role.name}` : RBAC_UPSELL_MESSAGE}
                  side="top"
                  className={rbacEnabled ? undefined : 'max-w-xs'}
                >
                  <span className="inline-flex">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={onEdit}
                      disabled={!rbacEnabled}
                      aria-label={`Edit role ${role.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </Hint>
                <Hint label={`Delete role ${role.name}`} side="top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={onDelete}
                    aria-label={`Delete role ${role.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </Hint>
              </>
            ) : (
              <Hint
                label={
                  rbacEnabled
                    ? `Start a custom role from ${role.name}'s capability set`
                    : RBAC_UPSELL_MESSAGE
                }
                side="top"
                className={rbacEnabled ? undefined : 'max-w-xs'}
              >
                <span className="inline-flex">
                  {/* Labeled (not icon-only): "Duplicate" is the documented path to
                      "editor minus X" — it must be findable at a glance. */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2.5 text-xs"
                    onClick={handleDuplicate}
                    disabled={duplicating || !rbacEnabled}
                    aria-label={`Duplicate role ${role.name}`}
                  >
                    {duplicating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    Duplicate
                  </Button>
                </span>
              </Hint>
            )}
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
  prefill,
  open,
  onOpenChange,
}: {
  accountId: string;
  mode: 'create' | 'edit';
  role?: IamRole;
  prefill?: RolePrefill | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = mode === 'edit' && !!role;

  const [name, setName] = useState(role?.name ?? prefill?.name ?? '');
  const [keyValue, setKeyValue] = useState(
    role?.key ?? (prefill ? slugifyKey(prefill.name) : ''),
  );
  const [keyTouched, setKeyTouched] = useState(isEdit);
  const [description, setDescription] = useState(role?.description ?? '');
  const [resourceType, setResourceType] = useState<ResourceType>(
    role?.resource_type ?? prefill?.resourceType ?? 'project',
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(prefill?.actions ?? []),
  );
  const [search, setSearch] = useState('');

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

  // Seed selected from loaded permissions (edit mode) once the query resolves.
  // Keyed on the resolved data so we never toggle against a not-yet-seeded set.
  useEffect(() => {
    if (isEdit && permsQuery.data) {
      setSelected(new Set(permsQuery.data.actions));
    }
  }, [isEdit, permsQuery.data]);

  const matrixActions = useMemo(
    () => (actionsQuery.data ?? []).filter((a) => a.resource_type === resourceType),
    [actionsQuery.data, resourceType],
  );

  const groups = useMemo(() => groupActions(matrixActions), [matrixActions]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        label: group.label,
        entries: group.entries.filter(
          (e) =>
            e.label.toLowerCase().includes(q) || e.action.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.entries.length > 0);
  }, [groups, search]);

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

  function setGroupSelected(entries: ActionCatalogEntry[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const entry of entries) {
        if (on) next.add(entry.action);
        else next.delete(entry.action);
      }
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
  const matrixError = actionsQuery.isError || (isEdit && permsQuery.isError);
  // Guard the matrix until the edit-mode permissions seed has resolved, so an
  // admin never toggles against an empty (not-yet-seeded) set.
  const matrixDisabled = isPending || matrixLoading || matrixError;

  const submitDisabled =
    isPending || !nameValid || (!isEdit && !keyValid) || matrixLoading || matrixError;

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
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Deploy operator"
                disabled={isPending}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-key">Key</Label>
              <Input
                id="role-key"
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
                <p className="text-xs text-destructive">
                  Lowercase letters, digits and underscores, 2–64 chars.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role-description">Description (optional)</Label>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for"
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role-resource-type">Applies to</Label>
            <Select
              value={resourceType}
              onValueChange={(v) => {
                setResourceType(v as ResourceType);
                if (!isEdit) setSelected(new Set());
              }}
              disabled={isPending || isEdit}
            >
              <SelectTrigger id="role-resource-type" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">Project</SelectItem>
                <SelectItem value="account">Account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="role-capability-search">Capabilities</Label>
              <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="role-capability-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search capabilities…"
                className="h-9 pl-9"
                disabled={matrixDisabled}
              />
            </div>
            <div className="max-h-[420px] space-y-4 overflow-y-auto rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
              {matrixError ? (
                <InfoBanner
                  tone="destructive"
                  title="Failed to load capabilities"
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        actionsQuery.refetch();
                        if (isEdit) permsQuery.refetch();
                      }}
                    >
                      Retry
                    </Button>
                  }
                >
                  {((actionsQuery.error || permsQuery.error) as Error)?.message}
                </InfoBanner>
              ) : matrixLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : matrixActions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No capabilities are available for this scope.
                </p>
              ) : filteredGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No capabilities match your search.
                </p>
              ) : (
                filteredGroups.map((group) => {
                  const allOn = group.entries.every((e) => selected.has(e.action));
                  return (
                    <div key={group.label} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {group.label}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => setGroupSelected(group.entries, !allOn)}
                          disabled={matrixDisabled}
                        >
                          {allOn ? 'Clear' : 'Select all'}
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {group.entries.map((entry) => (
                          <label
                            key={entry.action}
                            className={cn(
                              'flex cursor-pointer items-center gap-2 text-sm text-foreground',
                              matrixDisabled && 'pointer-events-none opacity-60',
                            )}
                          >
                            <Checkbox
                              checked={selected.has(entry.action)}
                              onCheckedChange={(c) => toggle(entry.action, c === true)}
                              disabled={matrixDisabled}
                            />
                            <span>{entry.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
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
