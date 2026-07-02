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
import {
  type IamPolicy,
  type IamRole,
  type AgentIdentity,
  type ServiceAccount,
  createPolicy,
  deletePolicy,
  listAgentIdentities,
  listServiceAccountsApi,
  listGroups,
  listPolicies,
  listRoles,
} from '@/lib/iam-client';
import {
  type KortixProject,
  listAccountMembers,
  listProjectsForAccount,
} from '@kortix/sdk/projects-client';

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

  const agentsQuery = useQuery({
    queryKey: ['iam-agent-identities', accountId],
    queryFn: () => listAgentIdentities(accountId),
    staleTime: 30_000,
  });

  // Standalone service accounts (CI/CD machine identities, no agent) — a
  // distinct `token` principal you can also bind a role to.
  const serviceAccountsQuery = useQuery({
    queryKey: ['iam-service-accounts', accountId],
    queryFn: () => listServiceAccountsApi(accountId),
    staleTime: 30_000,
  });

  const projectsQuery = useQuery({
    queryKey: ['account-projects', accountId],
    queryFn: () => listProjectsForAccount(accountId),
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

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentsQuery.data ?? []) map.set(a.service_account_id, a.agent_name ?? a.name);
    return map;
  }, [agentsQuery.data]);

  const serviceAccountNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of serviceAccountsQuery.data ?? []) map.set(s.service_account_id, s.name);
    return map;
  }, [serviceAccountsQuery.data]);

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQuery.data ?? []) map.set(p.project_id, p.name);
    return map;
  }, [projectsQuery.data]);

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

  function principalLabel(
    p: IamPolicy,
  ): { name: string; kind: 'Member' | 'Group' | 'Agent' | 'Service account' | null } {
    if (p.principal_type === 'member') {
      return { name: memberEmailById.get(p.principal_id) ?? p.principal_id, kind: 'Member' };
    }
    if (p.principal_type === 'group') {
      return { name: groupNameById.get(p.principal_id) ?? p.principal_id, kind: 'Group' };
    }
    // token = a standalone service account OR an agent's standing identity.
    const saName = serviceAccountNameById.get(p.principal_id);
    if (saName) return { name: saName, kind: 'Service account' };
    return { name: agentNameById.get(p.principal_id) ?? p.principal_id, kind: 'Agent' };
  }

  function scopeLabel(p: IamPolicy): string {
    if (p.scope_type === 'account') return 'Whole account';
    if (p.scope_type === 'project') {
      // Resolve to the human project name; fall back to the raw id so an admin
      // can still copy-verify which project a project-scoped assignment targets
      // even if the projects list hasn't loaded (or the project is gone).
      const id = p.scope_id ?? '';
      const name = id ? projectNameById.get(id) : undefined;
      return `Project ${name ?? id}`.trim();
    }
    return p.scope_type;
  }

  // The principal/role lookups feed both the table labels AND the create
  // dialog's pickers. If any fail, the surface can't render trustworthy rows
  // (a bare id everywhere) or offer a working create flow — so we treat the
  // whole panel as errored and let one Retry refetch them all.
  const lookupQueries = [
    rolesQuery,
    membersQuery,
    groupsQuery,
    agentsQuery,
    projectsQuery,
  ];
  const hasError = policiesQuery.isError || lookupQueries.some((q) => q.isError);
  const errorMessage =
    (policiesQuery.error as Error | undefined)?.message ??
    (lookupQueries.find((q) => q.isError)?.error as Error | undefined)?.message;

  function retryAll() {
    policiesQuery.refetch();
    for (const q of lookupQueries) q.refetch();
  }

  const newAssignmentButton = canManage ? (
    <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
      <Plus className="h-4 w-4" />
      New assignment
    </Button>
  ) : null;

  return (
    <SectionCard
      title="Assignments"
      description="Bind a member, group, or agent to a custom role at a scope."
      action={!hasError ? newAssignmentButton : null}
      flush
    >
      {hasError ? (
        <div className="px-6 py-5">
          <InfoBanner
            tone="destructive"
            title="Failed to load assignments"
            action={
              <Button variant="outline" size="sm" onClick={retryAll}>
                Retry
              </Button>
            }
          >
            {errorMessage}
          </InfoBanner>
        </div>
      ) : policiesQuery.isLoading ? (
        <div className="px-6 py-5">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : policies.length === 0 ? (
        <EmptyState
          icon={Shield}
          title="No assignments yet"
          description="Bind a member, group, or agent to a custom role."
          action={newAssignmentButton}
        />
      ) : (
        <div className="overflow-hidden px-6 py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                        <Hint label="Remove assignment">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteTarget(p)}
                            aria-label={`Remove assignment for ${principal.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </Hint>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CreateAssignmentDialog
        accountId={accountId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        roles={rolesQuery.data ?? []}
        rolesLoading={rolesQuery.isLoading}
        members={membersQuery.data ?? []}
        groups={groupsQuery.data ?? []}
        agents={agentsQuery.data ?? []}
        serviceAccounts={serviceAccountsQuery.data ?? []}
        projects={projectsQuery.data ?? []}
        projectsLoading={projectsQuery.isLoading}
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
    </SectionCard>
  );
}

// ─── Create dialog ────────────────────────────────────────────────────────

type PrincipalType = 'member' | 'group' | 'token';
type ScopeType = 'account' | 'project';

function CreateAssignmentDialog({
  accountId,
  open,
  onOpenChange,
  roles,
  rolesLoading,
  members,
  groups,
  agents,
  serviceAccounts,
  projects,
  projectsLoading,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  roles: IamRole[];
  rolesLoading: boolean;
  members: Array<{ user_id: string; email: string | null }>;
  groups: Array<{ group_id: string; name: string }>;
  agents: AgentIdentity[];
  serviceAccounts: ServiceAccount[];
  projects: KortixProject[];
  projectsLoading: boolean;
  onCreated: () => void;
}) {
  // `service_account` is a UI-only principal type — a standalone (non-agent)
  // service account. It maps to the backend `token` principal on submit.
  const [principalType, setPrincipalType] = useState<PrincipalType | 'service_account'>('member');
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
        // A standalone service account is a `token` principal on the backend.
        principalType: principalType === 'service_account' ? 'token' : principalType,
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
  // The project is now chosen from a Select populated with real project ids,
  // so "has a value" is sufficient — no UUID shape check needed.
  const scopeValid = scopeType === 'account' || !!projectId;
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
            Bind a member, group, or agent to a custom role at a scope.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assignment-principal-type">Principal type</Label>
            <Select
              value={principalType}
              onValueChange={(v) => {
                const next = v as PrincipalType;
                setPrincipalType(next);
                setPrincipalId('');
                // Agents are project-scoped — switch to project scope and make
                // the admin pick the project FIRST, then its agents. Member /
                // group default back to account scope.
                if (next === 'token') {
                  setScopeType('project');
                } else {
                  setScopeType('account');
                }
                setProjectId('');
              }}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="assignment-principal-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="group">Group</SelectItem>
                {/* token = a service-account / agent standing identity. Assigning
                    a role here promotes the agent to a standing teammate. */}
                <SelectItem value="token">Agent</SelectItem>
                {/* Standalone service account — a CI/CD / integration machine
                    identity (no agent). Backend principal is also `token`. */}
                <SelectItem value="service_account">Service account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Agents live IN a project — pick the project first, then its agents. */}
          {principalType === 'token' && (
            <div className="space-y-1.5">
              <Label htmlFor="assignment-agent-project">Project</Label>
              {projectsLoading ? (
                <p className="text-xs text-muted-foreground">Loading projects…</p>
              ) : projects.length === 0 ? (
                <p className="text-xs text-muted-foreground">No projects in this account yet.</p>
              ) : (
                <Select
                  value={projectId}
                  onValueChange={(pid) => {
                    setProjectId(pid);
                    setScopeType('project');
                    setPrincipalId('');
                  }}
                  disabled={mutation.isPending}
                >
                  <SelectTrigger id="assignment-agent-project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.project_id} value={p.project_id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                Agents are project-scoped — choose the project first.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="assignment-principal">
              {principalType === 'member'
                ? 'Member'
                : principalType === 'group'
                  ? 'Group'
                  : principalType === 'service_account'
                    ? 'Service account'
                    : 'Agent'}
            </Label>
            <Select
              value={principalId}
              onValueChange={(id) => {
                setPrincipalId(id);
                // An agent's standing role is almost always scoped to its own
                // project — prefill it so the admin doesn't paste a UUID. They
                // can still switch to account scope or another project.
                if (principalType === 'token') {
                  const agent = agents.find((a) => a.service_account_id === id);
                  if (agent?.project_id) {
                    setScopeType('project');
                    setProjectId(agent.project_id);
                  }
                }
              }}
              disabled={mutation.isPending || (principalType === 'token' && !projectId)}
            >
              <SelectTrigger id="assignment-principal">
                <SelectValue
                  placeholder={
                    principalType === 'member'
                      ? 'Select a member'
                      : principalType === 'group'
                        ? 'Select a group'
                        : principalType === 'service_account'
                          ? 'Select a service account'
                          : projectId
                            ? 'Select an agent'
                            : 'Select a project first'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {principalType === 'member'
                  ? members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.email ?? m.user_id}
                      </SelectItem>
                    ))
                  : principalType === 'group'
                    ? groups.map((g) => (
                        <SelectItem key={g.group_id} value={g.group_id}>
                          {g.name}
                        </SelectItem>
                      ))
                    : principalType === 'service_account'
                      ? (() => {
                          const active = serviceAccounts.filter((s) => s.status === 'active');
                          if (active.length === 0)
                            return <SelectItem value="__none" disabled>No active service accounts yet</SelectItem>;
                          return active.map((s) => (
                            <SelectItem key={s.service_account_id} value={s.service_account_id}>
                              {s.name}
                            </SelectItem>
                          ));
                        })()
                      : (() => {
                          // Agents are filtered to the project chosen above.
                          if (!projectId)
                            return <SelectItem value="__none" disabled>Select a project first</SelectItem>;
                          const projectAgents = agents.filter((a) => a.project_id === projectId);
                          if (projectAgents.length === 0)
                            return <SelectItem value="__none" disabled>No agents in this project</SelectItem>;
                          return projectAgents.map((a) => (
                            <SelectItem key={a.service_account_id} value={a.service_account_id}>
                              {a.agent_name ?? a.name}
                            </SelectItem>
                          ));
                        })()}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assignment-role">Role</Label>
            {rolesLoading ? (
              <p className="text-xs text-muted-foreground">Loading roles…</p>
            ) : customRoles.length === 0 ? (
              <p className="text-xs text-muted-foreground">Create a custom role first.</p>
            ) : (
              <Select value={roleId} onValueChange={setRoleId} disabled={mutation.isPending}>
                <SelectTrigger id="assignment-role">
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

          {/* Scope + project picker — member/group only. An agent's scope IS
              the project chosen above, so these are hidden for agents. */}
          {principalType !== 'token' && (
            <>
          <div className="space-y-1.5">
            <Label htmlFor="assignment-scope">Scope</Label>
            <Select
              value={scopeType}
              onValueChange={(v) => {
                const next = v as ScopeType;
                setScopeType(next);
                // Switching back to account scope clears any picked project so
                // a stale id can't ride along (createPolicy nulls scopeId on
                // account scope, but keep local state honest too).
                if (next === 'account') setProjectId('');
              }}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="assignment-scope">
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
              <Label htmlFor="assignment-project">Project</Label>
              {projectsLoading ? (
                <p className="text-xs text-muted-foreground">Loading projects…</p>
              ) : projects.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No projects in this account yet.
                </p>
              ) : (
                <Select
                  value={projectId}
                  onValueChange={setProjectId}
                  disabled={mutation.isPending}
                >
                  <SelectTrigger id="assignment-project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.project_id} value={p.project_id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                The project this role applies to.
              </p>
            </div>
          )}
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="assignment-expires">Expires (optional)</Label>
            <Input
              id="assignment-expires"
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
