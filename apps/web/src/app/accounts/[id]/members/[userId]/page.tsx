'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Shield, ShieldOff, Users } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { PoliciesTable } from '@/components/iam/policies-table';
import { setMemberSuperAdmin } from '@/lib/iam-client';
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
                Members
              </button>
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
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" size="sm">
                      {ROLE_LABEL[member.account_role] ?? member.account_role}
                    </Badge>
                    {member.is_super_admin && (
                      <Badge size="sm" className="gap-1">
                        <Shield />
                        Super-admin
                      </Badge>
                    )}
                    {member.groups?.map((g) => (
                      <Badge key={g.group_id} variant="secondary" size="sm">
                        <Users />
                        {g.name}
                      </Badge>
                    ))}
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
            <SectionCard
              tone="destructive"
              title="Failed to load member"
              description={(membersQuery.error as Error).message}
            />
          )}

          {!membersQuery.isLoading && !member && memberUserId && (
            <SectionCard flush>
              <EmptyState
                icon={Users}
                size="sm"
                title="Not a member"
                description="This user is not a member of this account."
              />
            </SectionCard>
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
