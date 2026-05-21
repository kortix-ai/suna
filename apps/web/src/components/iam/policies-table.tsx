'use client';

// Permission policies table — used by both the group-detail and the
// member-detail pages. The shape mirrors Cloudflare's policy editor:
// Scope · Applies to · Roles, with a Create policy modal that walks
// scope → applies to → roles.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type AccountGroup,
  type IamPolicy,
  type IamRole,
  type PolicyEffect,
  type PrincipalType,
  type ResourceType,
  createPolicy,
  deletePolicy,
  listGroups,
  listPolicies,
  listRoles,
  updatePolicy,
} from '@/lib/iam-client';
import {
  listAccountMembers,
  listProjectsForAccount,
  type AccountMember,
  type KortixProject,
} from '@/lib/projects-client';

// ─── Resource-type metadata (UI labels + which pickers are wired) ─────────

const RESOURCE_TYPE_META: Record<
  ResourceType,
  { label: string; pickerSupported: boolean }
> = {
  account: { label: 'Everything', pickerSupported: true },
  project: { label: 'Individual Projects', pickerSupported: true },
  member: { label: 'Individual Members', pickerSupported: true },
  group: { label: 'Individual Groups', pickerSupported: true },
  // Slug-based, ephemeral, or sub-resource — defer until they have stable UUIDs.
  sandbox: { label: 'Individual Sandboxes', pickerSupported: false },
  trigger: { label: 'Individual Triggers', pickerSupported: false },
  channel: { label: 'Individual Channels', pickerSupported: false },
};

// ─── PoliciesTable ─────────────────────────────────────────────────────────

interface PoliciesTableProps {
  accountId: string;
  principalType: PrincipalType;
  principalId: string;
  principalLabel: string;
  canManage: boolean;
}

export function PoliciesTable({
  accountId,
  principalType,
  principalId,
  principalLabel,
  canManage,
}: PoliciesTableProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  // Non-null = the dialog is open in "edit" mode for that policy. Mutually
  // exclusive with createOpen — opening one closes the other.
  const [editTarget, setEditTarget] = useState<IamPolicy | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IamPolicy | null>(null);

  const queryKey = ['iam-policies', accountId, principalType, principalId];

  const policiesQuery = useQuery({
    queryKey,
    queryFn: () => listPolicies(accountId, { principalType, principalId }),
    staleTime: 20_000,
  });

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 5 * 60_000,
  });

  const projectsQuery = useQuery({
    queryKey: ['projects-for-account', accountId],
    queryFn: () => listProjectsForAccount(accountId),
    staleTime: 30_000,
  });

  const accountMembersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });

  const accountGroupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    staleTime: 30_000,
  });

  const rolesById = useMemo(() => {
    const map = new Map<string, IamRole>();
    for (const r of rolesQuery.data ?? []) map.set(r.role_id, r);
    return map;
  }, [rolesQuery.data]);

  const projectsById = useMemo(() => {
    const map = new Map<string, KortixProject>();
    for (const p of projectsQuery.data ?? []) map.set(p.project_id, p);
    return map;
  }, [projectsQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (policyId: string) => deletePolicy(accountId, policyId),
    onSuccess: () => {
      toast.success('Policy removed');
      queryClient.invalidateQueries({ queryKey });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete policy'),
  });

  const policies = policiesQuery.data ?? [];

  return (
    <>
      <SectionCard
        title="Permission policies"
        description={`Policies grant ${principalLabel} access to specific resources.`}
        action={
          canManage && (
            <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Create a policy
            </Button>
          )
        }
        flush
      >
      {policiesQuery.isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">
            {(policiesQuery.error as Error)?.message || 'Failed to load policies'}
          </p>
        </div>
      )}

      {policiesQuery.isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="px-6 py-3">
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      )}

      {!policiesQuery.isLoading && policies.length === 0 && (
        <EmptyState
          icon={KeyRound}
          size="sm"
          title="No policies yet"
          description={
            canManage
              ? 'Create a policy to grant access to specific scopes and resources.'
              : 'No permission policies have been attached.'
          }
        />
      )}

      {!policiesQuery.isLoading && policies.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/20 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <th className="px-6 py-2.5 font-medium">Effect</th>
              <th className="px-3 py-2.5 font-medium">Scope</th>
              <th className="px-3 py-2.5 font-medium">Applies to</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="w-12 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {policies.map((p) => {
              const role = rolesById.get(p.role_id);
              const scopeLabel = RESOURCE_TYPE_META[p.scope_type]?.label ?? p.scope_type;
              const appliesTo =
                p.scope_type === 'account'
                  ? 'All resources in this account'
                  : p.scope_id === null
                    ? `All ${p.scope_type}s in this account`
                    : p.scope_type === 'project'
                      ? projectsById.get(p.scope_id)?.name ?? p.scope_id
                      : p.scope_id;
              const isDeny = p.effect === 'deny';
              return (
                <tr key={p.policy_id} className="hover:bg-muted/20">
                  <td className="px-6 py-3">
                    <Badge
                      variant={isDeny ? 'destructive' : 'outline'}
                      size="sm"
                      className="uppercase tracking-wider"
                    >
                      {p.effect}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 font-medium text-foreground">{scopeLabel}</td>
                  <td className="px-3 py-3 text-muted-foreground">{appliesTo}</td>
                  <td className="px-3 py-3">
                    {role ? (
                      <Badge variant="outline" size="sm">
                        {role.name}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">unknown role</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            aria-label="Policy actions"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => setEditTarget(p)}
                            className="gap-2"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit policy
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDeleteTarget(p)}
                            className="gap-2 text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove policy
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      </SectionCard>

      <CreatePolicyDialog
        open={createOpen || !!editTarget}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditTarget(null);
          } else if (!editTarget) {
            setCreateOpen(true);
          }
        }}
        accountId={accountId}
        principalType={principalType}
        principalId={principalId}
        principalLabel={principalLabel}
        roles={rolesQuery.data ?? []}
        projects={projectsQuery.data ?? []}
        members={accountMembersQuery.data ?? []}
        groups={accountGroupsQuery.data ?? []}
        editing={editTarget}
        onCreated={() => queryClient.invalidateQueries({ queryKey })}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Remove policy"
        description="This member or group will lose the permissions granted by this policy."
        confirmLabel="Remove policy"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.policy_id);
        }}
      />
    </>
  );
}

// ─── Create policy dialog ──────────────────────────────────────────────────

interface CreatePolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  principalType: PrincipalType;
  principalId: string;
  /** Used in the summary sentence above the Create button. */
  principalLabel: string;
  roles: IamRole[];
  projects: KortixProject[];
  members: AccountMember[];
  groups: AccountGroup[];
  /** Non-null = the dialog opens pre-filled to edit this policy in place
   * instead of creating new ones. Editing is single-role since a policy IS
   * a (principal, scope, role, effect) tuple — changing the role means
   * changing the row. */
  editing?: IamPolicy | null;
  onCreated: () => void;
}

function CreatePolicyDialog({
  open,
  onOpenChange,
  accountId,
  principalType,
  principalId,
  principalLabel,
  roles,
  projects,
  members,
  groups,
  editing,
  onCreated,
}: CreatePolicyDialogProps) {
  const isEditing = !!editing;
  const [effect, setEffect] = useState<PolicyEffect>('allow');
  const [scopeType, setScopeType] = useState<ResourceType | ''>('');
  const [scopeId, setScopeId] = useState<string>('');
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set());
  const [roleSearch, setRoleSearch] = useState('');

  // Hydrate from the policy being edited whenever the dialog opens in edit
  // mode. Clearing happens via reset() on close.
  useEffect(() => {
    if (open && editing) {
      setEffect(editing.effect);
      setScopeType(editing.scope_type);
      setScopeId(editing.scope_id ?? '');
      setSelectedRoleIds(new Set([editing.role_id]));
      setRoleSearch('');
    }
  }, [open, editing]);

  // Auto-focus the next picker as the user advances. Feels more like a
  // conversation than a form: pick a scope → focus jumps to the picker for
  // resources of that scope → then to the roles list.
  const appliesToTriggerRef = useRef<HTMLButtonElement>(null);
  const rolesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scopeType || scopeType === 'account') return;
    // Wait one frame so the newly-rendered SelectTrigger is in the DOM.
    const id = requestAnimationFrame(() => appliesToTriggerRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [scopeType]);

  useEffect(() => {
    const rolesReady = scopeType === 'account' || (!!scopeType && !!scopeId);
    if (!rolesReady) return;
    const id = requestAnimationFrame(() => {
      const first = rolesContainerRef.current?.querySelector<HTMLButtonElement>('button');
      first?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [scopeType, scopeId]);

  // Reset whenever the dialog closes so the next open is clean.
  function reset() {
    setEffect('allow');
    setScopeType('');
    setScopeId('');
    setSelectedRoleIds(new Set());
    setRoleSearch('');
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!scopeType) throw new Error('Pick a scope');
      if (selectedRoleIds.size === 0) throw new Error('Pick at least one role');
      const normalisedScopeId =
        scopeType === 'account'
          ? null
          : scopeId
            ? scopeId
            : null;

      // Edit mode: in-place mutation of the existing row. Single role only —
      // a policy IS one (scope, role, effect) triplet.
      if (editing) {
        const [roleId] = Array.from(selectedRoleIds);
        await updatePolicy(accountId, editing.policy_id, {
          scopeType,
          scopeId: normalisedScopeId,
          roleId,
          effect,
        });
        return;
      }

      // Create mode: one row per selected role (Cloudflare-style).
      for (const roleId of selectedRoleIds) {
        await createPolicy(accountId, {
          principalType,
          principalId,
          scopeType,
          scopeId: normalisedScopeId,
          roleId,
          effect,
        });
      }
    },
    onSuccess: () => {
      toast.success(editing ? 'Policy updated' : 'Policy created');
      onCreated();
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) =>
      toast.error(err.message || (editing ? 'Failed to update policy' : 'Failed to create policy')),
  });

  // Roles available for the chosen scope.
  //   - Everything scope (account)  → every role in the catalog
  //   - resource-specific scope     → ONLY roles tagged for that resource
  //
  // Cloudflare-style. Granting "Administrator" on a single project makes no
  // sense; the strict filter cuts the role list from ~15 down to ~4 for the
  // common case and removes a major source of confusion.
  const availableRoles = useMemo(() => {
    if (!scopeType) return [];
    if (scopeType === 'account') return roles;
    return roles.filter((r) => r.resource_type === scopeType);
  }, [roles, scopeType]);

  // Whether we have enough to submit.
  const ready = (() => {
    if (!scopeType || selectedRoleIds.size === 0) return false;
    if (scopeType !== 'account') {
      const meta = RESOURCE_TYPE_META[scopeType];
      if (!meta.pickerSupported) return false;
      if (!scopeId) return false;
    }
    return true;
  })();

  function toggleRole(roleId: string) {
    // Editing a single policy → behave like a radio (one role per policy).
    // Creating → checkbox (one policy per selected role).
    if (isEditing) {
      setSelectedRoleIds(new Set([roleId]));
      return;
    }
    setSelectedRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  // Roles section is revealed once the user has named a real target.
  // For account-Everything that's immediate; otherwise wait for the picker.
  const showRoles = scopeType === 'account' || (!!scopeType && !!scopeId);

  // Search only kicks in when the role list is long enough to warrant it
  // (Everything scope shows the full catalog). For 1–6 roles it's just noise.
  const SEARCH_THRESHOLD = 6;
  const filteredRoles = useMemo(() => {
    if (!roleSearch.trim()) return availableRoles;
    const q = roleSearch.trim().toLowerCase();
    return availableRoles.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q),
    );
  }, [availableRoles, roleSearch]);

  // Human-readable summary fragments rendered above the Create button.
  const selectedRoleNames = useMemo(() => {
    if (selectedRoleIds.size === 0) return '';
    return availableRoles
      .filter((r) => selectedRoleIds.has(r.role_id))
      .map((r) => r.name)
      .join(', ');
  }, [availableRoles, selectedRoleIds]);

  const appliesToLabel = useMemo(() => {
    if (scopeType === 'account') return 'all resources in this account';
    if (scopeType === 'project') {
      return projects.find((p) => p.project_id === scopeId)?.name ?? 'this project';
    }
    if (scopeType === 'member') {
      const m = members.find((x) => x.user_id === scopeId);
      return m?.email ?? 'this member';
    }
    if (scopeType === 'group') {
      return groups.find((g) => g.group_id === scopeId)?.name ?? 'this group';
    }
    return 'this scope';
  }, [scopeType, scopeId, projects, members, groups]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (createMutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit policy' : 'Create policy'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Change the scope, role, or effect. The principal stays the same.'
              : 'Grant access to a scope. One policy is created per role.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Step 1: Scope (always visible) ─────────────────────── */}
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Select
              value={scopeType || undefined}
              onValueChange={(v) => {
                setScopeType(v as ResourceType);
                setScopeId('');
                setSelectedRoleIds(new Set());
              }}
              disabled={createMutation.isPending}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a scope..." />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Account-level
                  </SelectLabel>
                  <SelectItem value="account">Everything</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Resource-specific
                  </SelectLabel>
                  {(['project', 'member', 'group', 'sandbox', 'trigger', 'channel'] as ResourceType[]).map(
                    (rt) => {
                      const meta = RESOURCE_TYPE_META[rt];
                      return (
                        <SelectItem
                          key={rt}
                          value={rt}
                          disabled={!meta.pickerSupported}
                          className={!meta.pickerSupported ? 'italic opacity-50' : undefined}
                        >
                          {meta.label}
                          {!meta.pickerSupported && (
                            <span className="ml-2 text-[10px] text-muted-foreground">soon</span>
                          )}
                        </SelectItem>
                      );
                    },
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {/* ── Step 2: Applies to (only after a scope is picked) ─── */}
          {scopeType && (
            <div className="space-y-1.5">
              <Label>Applies to</Label>
              {scopeType === 'account' && (
                <p className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                  All resources in this account
                </p>
              )}
              {scopeType === 'project' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a project..." />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No projects in this account
                      </div>
                    ) : (
                      projects.map((p) => (
                        <SelectItem key={p.project_id} value={p.project_id}>
                          {p.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              {scopeType === 'member' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a member..." />
                  </SelectTrigger>
                  <SelectContent>
                    {members.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No members in this account
                      </div>
                    ) : (
                      members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.email ?? m.user_id}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              {scopeType === 'group' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a group..." />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No groups in this account
                      </div>
                    ) : (
                      groups.map((g) => (
                        <SelectItem key={g.group_id} value={g.group_id}>
                          {g.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* ── Step 3: Roles (only after Applies-to is satisfied) ── */}
          {showRoles && (
            <div className="space-y-1.5">
              <Label>{isEditing ? 'Role' : 'Roles'}</Label>
              {!isEditing && availableRoles.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Each selected role becomes its own policy.
                </p>
              )}
              {availableRoles.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  No roles available for this scope.
                </p>
              ) : (
                <>
                  {availableRoles.length > SEARCH_THRESHOLD && (
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={roleSearch}
                        onChange={(e) => setRoleSearch(e.target.value)}
                        placeholder="Search roles..."
                        className="h-8 pl-8 text-sm"
                        disabled={createMutation.isPending}
                      />
                    </div>
                  )}
                  <div
                    ref={rolesContainerRef}
                    role={isEditing ? 'radiogroup' : 'group'}
                    className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-border/60 p-2"
                  >
                    {filteredRoles.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No roles match &ldquo;{roleSearch}&rdquo;.
                      </p>
                    ) : (
                      filteredRoles.map((r) => {
                        const checked = selectedRoleIds.has(r.role_id);
                        return (
                          <button
                            key={r.role_id}
                            type="button"
                            role={isEditing ? 'radio' : 'checkbox'}
                            aria-checked={checked}
                            onClick={() => toggleRole(r.role_id)}
                            className={`flex w-full cursor-pointer items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                              checked ? 'bg-primary/5' : 'hover:bg-muted/40'
                            }`}
                            disabled={createMutation.isPending}
                          >
                            {/* Native input purely as the visual indicator —
                                clicks are absorbed by the wrapping button. */}
                            <input
                              type={isEditing ? 'radio' : 'checkbox'}
                              checked={checked}
                              readOnly
                              tabIndex={-1}
                              className={`mt-0.5 h-3.5 w-3.5 border-border accent-primary ${
                                isEditing ? 'rounded-full' : 'rounded'
                              }`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">
                                  {r.name}
                                </span>
                                {r.is_system && (
                                  <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                                    system
                                  </Badge>
                                )}
                              </div>
                              {r.description && (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {r.description}
                                </p>
                              )}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Optional: Deny toggle (subdued, after Roles) ──────── */}
          {showRoles && availableRoles.length > 0 && (
            <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={effect === 'deny'}
                onChange={(e) => setEffect(e.target.checked ? 'deny' : 'allow')}
                disabled={createMutation.isPending}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-destructive"
              />
              <span>
                Make this a <strong className="text-destructive">deny</strong> policy
                {effect === 'deny' && (
                  <span className="block text-[11px] text-muted-foreground">
                    Revokes the role&apos;s actions on this scope. Wins over any allow.
                  </span>
                )}
              </span>
            </label>
          )}

          {/* ── Summary line (visible once ready) ─────────────────── */}
          {ready && (
            <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-2.5 text-sm leading-relaxed text-foreground">
              <span className="text-muted-foreground">{principalLabel}</span> will
              be{' '}
              <strong className={effect === 'deny' ? 'text-destructive' : 'text-foreground'}>
                {effect === 'deny' ? 'denied' : 'allowed'}
              </strong>{' '}
              <strong>{selectedRoleNames}</strong> on{' '}
              <strong>{appliesToLabel}</strong>.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={!ready || createMutation.isPending}
            className="gap-1.5"
            variant={effect === 'deny' ? 'destructive' : 'default'}
          >
            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEditing
              ? 'Save changes'
              : effect === 'deny'
                ? 'Create deny policy'
                : 'Create policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
