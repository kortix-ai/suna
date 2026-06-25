'use client';

// Policy assignment surface. Binds a principal (member or group) to a
// CUSTOM role at a scope (whole account or a single project). Allow-only,
// v1 — no deny effect, no conditions, no token principals, no project_group
// scope (the backend rejects/ignores them).

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, Shield } from 'lucide-react';
import { toast } from '@/lib/toast';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type IamPolicy,
  type IamRole,
  createPolicy,
  deletePolicy,
  listGroups,
  listPolicies,
  listRoles,
} from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PolicyAssignmentsProps {
  accountId: string;
  canManage: boolean;
}

export function PolicyAssignments({ accountId, canManage }: PolicyAssignmentsProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IamPolicy | null>(null);

  const policiesQuery = useQuery({
    queryKey: ['iam-policies', accountId],
    queryFn: () => listPolicies(accountId),
    staleTime: 30_000,
  });

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 30_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });

  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    staleTime: 30_000,
  });

  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rolesQuery.data ?? []) map.set(r.role_id, r.name);
    return map;
  }, [rolesQuery.data]);

  const memberEmailById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) map.set(m.user_id, m.email ?? m.user_id);
    return map;
  }, [membersQuery.data]);

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groupsQuery.data ?? []) map.set(g.group_id, g.name);
    return map;
  }, [groupsQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (policyId: string) => deletePolicy(accountId, policyId),
    onSuccess: () => {
      toast.success('Assignment removed');
      queryClient.invalidateQueries({ queryKey: ['iam-policies', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove assignment'),
  });

  const policies = policiesQuery.data ?? [];

  function principalLabel(p: IamPolicy): { name: string; kind: 'Member' | 'Group' | null } {
    if (p.principal_type === 'member') {
      return { name: memberEmailById.get(p.principal_id) ?? p.principal_id, kind: 'Member' };
    }
    if (p.principal_type === 'group') {
      return { name: groupNameById.get(p.principal_id) ?? p.principal_id, kind: 'Group' };
    }
    // token (legacy) — show raw id, no resolution
    return { name: p.principal_id, kind: null };
  }

  function scopeLabel(p: IamPolicy): string {
    if (p.scope_type === 'account') return 'Whole account';
    if (p.scope_type === 'project') {
      // Full id (not truncated) so an admin can copy-verify which project a
      // project-scoped assignment targets.
      return `Project ${p.scope_id ?? ''}`.trim();
    }
    return p.scope_type;
  }

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Assignments
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bind a member or group to a custom role at a scope.
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              New assignment
            </Button>
          )}
        </div>
      </header>

      <div className="px-6 py-4">
        {policiesQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : policies.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No assignments yet. Bind a member or group to a custom role to grant access.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="py-2 font-medium">Principal</th>
                <th className="py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Scope</th>
                <th className="py-2 font-medium">Expires</th>
                <th className="w-16 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {policies.map((p) => {
                const principal = principalLabel(p);
                return (
                  <tr key={p.policy_id} className="hover:bg-muted/20">
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{principal.name}</span>
                        {principal.kind && (
                          <Badge variant="outline" size="sm" className="font-normal">
                            {principal.kind}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-foreground">
                      {roleNameById.get(p.role_id) ?? p.role_id}
                    </td>
                    <td className="py-2 text-muted-foreground">{scopeLabel(p)}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {p.expires_at ? new Date(p.expires_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-2 text-right">
                      {canManage && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(p)}
                          aria-label="Remove assignment"
                          title="Remove assignment"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <CreateAssignmentDialog
        accountId={accountId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        roles={rolesQuery.data ?? []}
        rolesLoading={rolesQuery.isLoading}
        members={membersQuery.data ?? []}
        groups={groupsQuery.data ?? []}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['iam-policies', accountId] });
          setCreateOpen(false);
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Remove assignment"
        description={
          deleteTarget
            ? `Remove this assignment? The principal will lose the access this policy grants.`
            : ''
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.policy_id);
        }}
      />
    </section>
  );
}

// ─── Create dialog ────────────────────────────────────────────────────────

type PrincipalType = 'member' | 'group';
type ScopeType = 'account' | 'project';

function CreateAssignmentDialog({
  accountId,
  open,
  onOpenChange,
  roles,
  rolesLoading,
  members,
  groups,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  roles: IamRole[];
  rolesLoading: boolean;
  members: Array<{ user_id: string; email: string | null }>;
  groups: Array<{ group_id: string; name: string }>;
  onCreated: () => void;
}) {
  const [principalType, setPrincipalType] = useState<PrincipalType>('member');
  const [principalId, setPrincipalId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState<ScopeType>('account');
  const [projectId, setProjectId] = useState('');
  const [expires, setExpires] = useState('');

  // Only custom roles are bindable via policies; built-ins 400 the backend.
  const customRoles = useMemo(() => roles.filter((r) => !r.is_system), [roles]);

  function reset() {
    setPrincipalType('member');
    setPrincipalId('');
    setRoleId('');
    setScopeType('account');
    setProjectId('');
    setExpires('');
  }

  const mutation = useMutation({
    mutationFn: () => {
      // A bare YYYY-MM-DD parses as UTC midnight, which can read as the day
      // BEFORE for western-timezone admins. Anchor to end-of-day LOCAL so the
      // chosen date is the last day the assignment is valid.
      const expiresIso = expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined;
      return createPolicy(accountId, {
        principalType,
        principalId,
        scopeType,
        scopeId: scopeType === 'project' ? projectId.trim() : null,
        roleId,
        expires_at: expiresIso,
      });
    },
    onSuccess: () => {
      toast.success('Assignment created');
      reset();
      onCreated();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create assignment'),
  });

  const principalValid = !!principalId;
  const projectIdTrimmed = projectId.trim();
  const projectIdValid = UUID_RE.test(projectIdTrimmed);
  const scopeValid = scopeType === 'account' || projectIdValid;
  const isValid = principalValid && !!roleId && scopeValid;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New assignment</DialogTitle>
          <DialogDescription>
            Bind a member or group to a custom role at a scope.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Principal type</Label>
            <Select
              value={principalType}
              onValueChange={(v) => {
                setPrincipalType(v as PrincipalType);
                setPrincipalId('');
              }}
              disabled={mutation.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="group">Group</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{principalType === 'member' ? 'Member' : 'Group'}</Label>
            <Select
              value={principalId}
              onValueChange={setPrincipalId}
              disabled={mutation.isPending}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={principalType === 'member' ? 'Select a member' : 'Select a group'}
                />
              </SelectTrigger>
              <SelectContent>
                {principalType === 'member'
                  ? members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.email ?? m.user_id}
                      </SelectItem>
                    ))
                  : groups.map((g) => (
                      <SelectItem key={g.group_id} value={g.group_id}>
                        {g.name}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Role</Label>
            {rolesLoading ? (
              <p className="text-xs text-muted-foreground">Loading roles…</p>
            ) : customRoles.length === 0 ? (
              <p className="text-xs text-muted-foreground">Create a custom role first.</p>
            ) : (
              <Select value={roleId} onValueChange={setRoleId} disabled={mutation.isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a custom role" />
                </SelectTrigger>
                <SelectContent>
                  {customRoles.map((r) => (
                    <SelectItem key={r.role_id} value={r.role_id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Select
              value={scopeType}
              onValueChange={(v) => setScopeType(v as ScopeType)}
              disabled={mutation.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">Whole account</SelectItem>
                <SelectItem value="project">A specific project</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scopeType === 'project' && (
            <div className="space-y-1.5">
              <Label>Project ID</Label>
              <Input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                disabled={mutation.isPending}
              />
              {projectIdTrimmed && !projectIdValid ? (
                <p className="text-xs text-destructive">
                  Enter a valid project ID (UUID).
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The project this role applies to.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Expires (optional)</Label>
            <Input
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
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
            disabled={!isValid || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
