'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Search, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  deleteRole,
  getRolePermissions,
  getRoleUsage,
  listActions,
  listRoles,
  updateRole,
  updateRolePermissions,
} from '@/lib/iam-client';
import { getAccount } from '@/lib/projects-client';
import { usePermission } from '@/lib/use-permission';

export default function RoleDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; roleId: string }>();
  const accountId = params?.id;
  const roleId = params?.roleId;
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  // Use the roles list query so navigation between the tab and detail page
  // shares cache. Fetching a single role by id would require a new endpoint
  // for what's already a tiny payload.
  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const role = useMemo(
    () => rolesQuery.data?.find((r) => r.role_id === roleId),
    [rolesQuery.data, roleId],
  );

  const permissionsQuery = useQuery({
    queryKey: ['iam-role-permissions', accountId, roleId],
    queryFn: () => getRolePermissions(accountId!, roleId!),
    enabled: !!user && !!accountId && !!roleId,
    staleTime: 30_000,
  });

  const usageQuery = useQuery({
    queryKey: ['iam-role-usage', accountId, roleId],
    queryFn: () => getRoleUsage(accountId!, roleId!),
    enabled: !!user && !!accountId && !!roleId,
    staleTime: 10_000,
  });

  const actionsQuery = useQuery({
    queryKey: ['iam-actions', accountId],
    queryFn: () => listActions(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 60 * 60_000,
  });

  const canUpdate = usePermission(accountId, 'role.update').allowed;
  const canDelete = usePermission(accountId, 'role.delete').allowed;
  const isSystem = role?.is_system === true;
  const editable = canUpdate && !isSystem;

  // Edit-in-place state for the metadata form (name/description).
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (role) {
      setName(role.name);
      setDescription(role.description ?? '');
    }
  }, [role]);

  const metaDirty = role && (name.trim() !== role.name || description.trim() !== (role.description ?? ''));

  const saveMetaMutation = useMutation({
    mutationFn: () =>
      updateRole(accountId!, roleId!, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Role updated');
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update role'),
  });

  // Permissions editing state — start from the fetched set, mutate locally,
  // commit explicitly. Mirrors how the policy modal handles role pickers.
  const [draftActions, setDraftActions] = useState<Set<string>>(new Set());
  const [actionSearch, setActionSearch] = useState('');
  useEffect(() => {
    if (permissionsQuery.data) {
      setDraftActions(new Set(permissionsQuery.data.actions));
    }
  }, [permissionsQuery.data]);

  const availableActions = useMemo(() => {
    if (!role) return [];
    return (actionsQuery.data ?? []).filter((a) => a.resource_type === role.resource_type);
  }, [actionsQuery.data, role]);

  const filteredActions = useMemo(() => {
    const q = actionSearch.trim().toLowerCase();
    if (!q) return availableActions;
    return availableActions.filter(
      (a) => a.action.toLowerCase().includes(q) || a.label.toLowerCase().includes(q),
    );
  }, [availableActions, actionSearch]);

  const permsDirty = useMemo(() => {
    const original = new Set(permissionsQuery.data?.actions ?? []);
    if (original.size !== draftActions.size) return true;
    for (const a of original) if (!draftActions.has(a)) return true;
    return false;
  }, [draftActions, permissionsQuery.data]);

  const savePermsMutation = useMutation({
    mutationFn: () => updateRolePermissions(accountId!, roleId!, [...draftActions]),
    onSuccess: () => {
      toast.success('Permissions updated');
      queryClient.invalidateQueries({
        queryKey: ['iam-role-permissions', accountId, roleId],
      });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update permissions'),
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(accountId!, roleId!),
    onSuccess: () => {
      toast.success('Role deleted');
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      router.push(`/accounts/${accountId}`);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete role'),
  });

  function toggleAction(action: string) {
    setDraftActions((prev) => {
      const next = new Set(prev);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  }

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const usageCount = usageQuery.data?.policy_count ?? 0;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => router.push('/projects')}
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to projects
            </button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => router.push('/accounts')}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                Accounts
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button
                type="button"
                onClick={() => router.push(`/accounts/${accountId}`)}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                {accountQuery.data?.name ?? 'Account'}
              </button>
              <span className="text-muted-foreground/40">/</span>
              <span>Roles</span>
              <span className="text-muted-foreground/40">/</span>
              {rolesQuery.isLoading ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span className="truncate font-medium text-foreground">
                  {role?.name ?? 'Role'}
                </span>
              )}
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {rolesQuery.isLoading ? <Skeleton className="h-7 w-48" /> : role?.name}
              </h1>
              {role && (
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="font-mono">{role.key}</code>
                  <span className="text-muted-foreground/40">·</span>
                  {role.is_system ? (
                    <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                      system
                    </Badge>
                  ) : (
                    <Badge className="h-4 rounded-md px-1 text-[9px] font-normal">custom</Badge>
                  )}
                  <span className="text-muted-foreground/40">·</span>
                  <span>Resource type: {role.resource_type}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>
                    {usageQuery.isLoading
                      ? 'checking usage...'
                      : `Used by ${usageCount} ${usageCount === 1 ? 'policy' : 'policies'}`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {!rolesQuery.isLoading && !role && roleId && (
            <div className="rounded-xl border border-border/70 bg-card p-6">
              <p className="text-sm text-muted-foreground">
                This role doesn&apos;t exist or you don&apos;t have access.
              </p>
            </div>
          )}

          {isSystem && (
            <section className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 px-5 py-4 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium text-foreground">System role — read-only</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  System roles ship with the platform. To customize, create a new
                  role with the actions you want and attach that instead.
                </p>
              </div>
            </section>
          )}

          {/* Metadata */}
          {role && (
            <section className="rounded-xl border border-border/70 bg-card">
              <header className="border-b border-border/60 px-6 py-4">
                <h2 className="text-base font-semibold text-foreground">Details</h2>
              </header>
              <div className="space-y-4 px-6 py-5">
                <div className="space-y-1.5">
                  <Label htmlFor="role-name">Name</Label>
                  <Input
                    id="role-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={128}
                    disabled={!editable || saveMetaMutation.isPending}
                    className="max-w-md"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="role-description">Description</Label>
                  <Input
                    id="role-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={256}
                    disabled={!editable || saveMetaMutation.isPending}
                    className="max-w-md"
                  />
                </div>
                {editable && (
                  <div className="flex justify-end border-t border-border/60 pt-4">
                    <Button
                      onClick={() => saveMetaMutation.mutate()}
                      disabled={!metaDirty || !name.trim() || saveMetaMutation.isPending}
                      className="gap-1.5"
                    >
                      {saveMetaMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                      Save
                    </Button>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Permissions */}
          {role && (
            <section className="rounded-xl border border-border/70 bg-card">
              <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    Permissions{' '}
                    <span className="font-normal text-muted-foreground">
                      ({draftActions.size})
                    </span>
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Actions this role grants when attached to a policy.
                  </p>
                </div>
                {editable && permsDirty && (
                  <Button
                    onClick={() => savePermsMutation.mutate()}
                    disabled={savePermsMutation.isPending || draftActions.size === 0}
                    className="gap-1.5"
                  >
                    {savePermsMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save changes
                  </Button>
                )}
              </header>

              {(permissionsQuery.isLoading || actionsQuery.isLoading) && (
                <div className="px-6 py-4">
                  <Skeleton className="h-6 w-full" />
                </div>
              )}

              {!permissionsQuery.isLoading && availableActions.length > 6 && (
                <div className="border-b border-border/60 px-6 py-3">
                  <div className="relative max-w-sm">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={actionSearch}
                      onChange={(e) => setActionSearch(e.target.value)}
                      placeholder="Search actions..."
                      className="h-9 pl-9"
                    />
                  </div>
                </div>
              )}

              {!permissionsQuery.isLoading && !actionsQuery.isLoading && (
                <div className="max-h-96 overflow-y-auto px-2 py-2">
                  {filteredActions.length === 0 ? (
                    <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                      {actionSearch ? `No actions match "${actionSearch}".` : 'No actions available.'}
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {filteredActions.map((a) => {
                        const checked = draftActions.has(a.action);
                        return (
                          <li key={a.action}>
                            <button
                              type="button"
                              onClick={() => editable && toggleAction(a.action)}
                              disabled={!editable}
                              className={`flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left transition-colors ${
                                editable ? 'cursor-pointer' : 'cursor-default'
                              } ${checked ? 'bg-primary/5' : editable ? 'hover:bg-muted/40' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                readOnly
                                tabIndex={-1}
                                className="h-3.5 w-3.5 rounded border-border accent-primary"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-foreground">
                                  {a.label}
                                </span>
                                <code className="block truncate text-[10px] font-mono text-muted-foreground">
                                  {a.action}
                                </code>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Danger zone */}
          {role && canDelete && !isSystem && (
            <section className="rounded-xl border border-destructive/30 bg-destructive/5">
              <header className="border-b border-destructive/20 px-6 py-4">
                <h2 className="text-base font-semibold text-destructive">Danger zone</h2>
                <p className="mt-0.5 text-xs text-destructive/80">
                  Roles in use by any policy cannot be deleted until the
                  referencing policies are removed.
                </p>
              </header>
              <div className="flex items-center justify-between gap-3 px-6 py-4">
                <p className="text-sm text-foreground">
                  Delete this role
                  {usageCount > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (currently used by {usageCount} {usageCount === 1 ? 'policy' : 'policies'})
                    </span>
                  )}
                </p>
                <Button
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                  disabled={usageCount > 0}
                  title={
                    usageCount > 0
                      ? `Cannot delete: ${usageCount} ${usageCount === 1 ? 'policy still references' : 'policies still reference'} this role`
                      : undefined
                  }
                >
                  Delete role
                </Button>
              </div>
            </section>
          )}

          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete role"
            description={`Delete "${role?.name ?? 'this role'}"? This cannot be undone.`}
            confirmLabel="Delete role"
            isPending={deleteMutation.isPending}
            onConfirm={() => deleteMutation.mutate()}
          />
        </div>
      </main>
    </div>
  );
}
