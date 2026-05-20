'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Shield, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { PoliciesTable } from '@/components/iam/policies-table';
import { listGroups, setMemberSuperAdmin } from '@/lib/iam-client';
import { getAccount, listAccountMembers } from '@/lib/projects-client';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export default function MemberDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; userId: string }>();
  const accountId = params?.id;
  const memberUserId = params?.userId;
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const [grantConfirmOpen, setGrantConfirmOpen] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 20_000,
  });

  // We currently don't expose a per-member "list groups they belong to" API,
  // so derive client-side by walking every group's members. Cheap because the
  // groups list is small. (Move server-side if a large account hits this.)
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const setSuperAdminMutation = useMutation({
    mutationFn: (next: boolean) =>
      setMemberSuperAdmin(accountId!, memberUserId!, next),
    onSuccess: (res) => {
      toast.success(res.is_super_admin ? 'Granted super-admin' : 'Revoked super-admin');
      queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
      setGrantConfirmOpen(false);
      setRevokeConfirmOpen(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update'),
  });

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const members = membersQuery.data ?? [];
  const member = useMemo(
    () => members.find((m) => m.user_id === memberUserId),
    [members, memberUserId],
  );
  const canManage = account?.role === 'owner' || account?.role === 'admin';

  // Owners can promote anyone; super-admin promotion needs MEMBER_SUPER_ADMIN_GRANT
  // which the IAM engine only allows for Super Administrators (currently
  // every owner). We just gate the button on isOwner to keep the UI honest.
  const canPromoteSuperAdmin = account?.role === 'owner';

  // Note: we don't currently surface is_super_admin in listAccountMembers, so
  // we can't show a pre-existing on/off state. Wire the column once the
  // members endpoint includes it.

  const memberLabel = member?.email ?? memberUserId ?? 'Member';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => router.push(`/accounts/${accountId}`)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to account
            </button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Members</span>
              <span className="text-muted-foreground/40">/</span>
              {membersQuery.isLoading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <span className="truncate font-medium text-foreground">{memberLabel}</span>
              )}
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  {memberLabel}
                </h1>
                {member && (
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] font-normal">
                      {ROLE_LABEL[member.account_role] ?? member.account_role}
                    </Badge>
                    {member.is_super_admin && (
                      <Badge className="h-5 gap-1 rounded-md px-1.5 text-[10px] font-normal">
                        <Shield className="h-2.5 w-2.5" />
                        Super-admin
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Joined {new Date(member.joined_at).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>
              {canPromoteSuperAdmin && memberUserId !== user.id && member?.is_super_admin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevokeConfirmOpen(true)}
                  className="gap-1.5 text-destructive hover:text-destructive"
                  disabled={setSuperAdminMutation.isPending}
                >
                  <ShieldOff className="h-3.5 w-3.5" />
                  Revoke super-admin
                </Button>
              )}
              {canPromoteSuperAdmin && memberUserId !== user.id && !member?.is_super_admin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setGrantConfirmOpen(true)}
                  className="gap-1.5"
                  disabled={setSuperAdminMutation.isPending}
                >
                  <Shield className="h-3.5 w-3.5" />
                  Grant super-admin
                </Button>
              )}
            </div>
          </div>

          {membersQuery.isError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
              <p className="text-sm font-medium text-destructive">Failed to load member</p>
              <p className="mt-1 text-xs text-destructive/80">
                {(membersQuery.error as Error).message}
              </p>
            </div>
          )}

          {!membersQuery.isLoading && !member && memberUserId && (
            <div className="rounded-xl border border-border/70 bg-card p-6">
              <p className="text-sm text-muted-foreground">
                This user is not a member of this account.
              </p>
            </div>
          )}

          {account && member && (
            <PoliciesTable
              accountId={account.account_id}
              principalType="member"
              principalId={member.user_id}
              principalLabel={memberLabel}
              canManage={canManage}
            />
          )}

          <ConfirmDialog
            open={grantConfirmOpen}
            onOpenChange={setGrantConfirmOpen}
            title="Grant super-admin?"
            description={
              <span>
                Super-admin bypasses every IAM check. <strong>{memberLabel}</strong> will be
                able to do anything in this account, including managing billing and deleting
                the account. Only grant this to people you fully trust.
              </span>
            }
            confirmLabel="Grant super-admin"
            isPending={setSuperAdminMutation.isPending}
            onConfirm={() => setSuperAdminMutation.mutate(true)}
          />

          <ConfirmDialog
            open={revokeConfirmOpen}
            onOpenChange={setRevokeConfirmOpen}
            title="Revoke super-admin?"
            description={
              <span>
                <strong>{memberLabel}</strong> will lose the bypass. From now on, every
                action they perform will go through the normal policy checks. They may
                lose access to parts of the account if no explicit policies grant it.
              </span>
            }
            confirmLabel="Revoke super-admin"
            isPending={setSuperAdminMutation.isPending}
            onConfirm={() => setSuperAdminMutation.mutate(false)}
          />
        </div>
      </main>
    </div>
  );
}
