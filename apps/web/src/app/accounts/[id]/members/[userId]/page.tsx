'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Shield, ShieldOff, Users, X } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { PoliciesTable } from '@/components/iam/policies-table';
import { PermissionBoundaryCard } from '@/components/iam/permission-boundary-card';
import {
  listMemberGroups,
  setMemberSuperAdmin,
  type MemberGroupSummary,
} from '@/lib/iam-client';
import { getAccount, listAccountMembers } from '@/lib/projects-client';
import { usePermission, usePermissionsFor } from '@/lib/use-permission';

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

  // Server-side derivation of this member's group memberships. Drives the
  // "Member of these groups" section so admins can see at a glance which
  // policies the user inherits via group attachments.
  const memberGroupsQuery = useQuery({
    queryKey: ['member-groups', accountId, memberUserId],
    queryFn: () => listMemberGroups(accountId!, memberUserId!),
    enabled: !!user && !!accountId && !!memberUserId,
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

  // All hooks MUST be called before any conditional return (rules of
  // hooks). useMemo + usePermission live above the auth-loading guard.
  const members = membersQuery.data ?? [];
  const member = useMemo(
    () => members.find((m) => m.user_id === memberUserId),
    [members, memberUserId],
  );
  // Granular permissions from the IAM engine. canManage gates the policies
  // table (create/edit/delete); canPromoteSuperAdmin gates the bypass toggle.
  const canManage = usePermission(accountId, 'policy.create').allowed;
  const canPromoteSuperAdmin = usePermission(
    accountId,
    'member.super_admin.grant',
  ).allowed;

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;

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
              <div className="flex items-start gap-3">
                <UserAvatar
                  email={member?.email ?? memberLabel}
                  name={member?.email ?? undefined}
                  size="lg"
                  className="mt-0.5"
                />
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                    {memberLabel}
                  </h1>
                  {member && (
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="outline" size="sm">
                        {ROLE_LABEL[member.account_role] ?? member.account_role}
                      </Badge>
                      {member.is_super_admin && (
                        <Badge variant="secondary" size="sm" className="gap-1">
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
              </div>
              {canPromoteSuperAdmin && memberUserId !== user.id && member?.is_super_admin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevokeConfirmOpen(true)}
                  className="gap-1.5"
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
            <InfoBanner tone="destructive" title="Failed to load member">
              {(membersQuery.error as Error).message}
            </InfoBanner>
          )}

          {!membersQuery.isLoading && !member && memberUserId && (
            <InfoBanner tone="neutral">
              This user is not a member of this account.
            </InfoBanner>
          )}

          {account && member && (
            <MemberGroupsCard
              accountId={account.account_id}
              memberGroups={memberGroupsQuery.data ?? []}
              isLoading={memberGroupsQuery.isLoading}
            />
          )}

          {account && member && (
            <CapabilitiesCard
              accountId={account.account_id}
              memberUserId={member.user_id}
            />
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

          {account && member && (
            <PermissionBoundaryCard
              accountId={account.account_id}
              userId={member.user_id}
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

// ─── Capabilities card ────────────────────────────────────────────────────
// "What this member can actually do" — a curated grid of common account-level
// capabilities, each probed via the IAM engine. Resolves the gap where an
// admin sees explicit policies + groups but can't easily tell which broad
// powers the union grants.

const CAPABILITY_GROUPS: Array<{
  heading: string;
  items: Array<{ label: string; action: string }>;
}> = [
  {
    heading: 'Account',
    items: [
      { label: 'Rename account', action: 'account.write' },
      { label: 'Delete account', action: 'account.delete' },
      { label: 'Manage billing', action: 'billing.write' },
      { label: 'Read audit log', action: 'audit.read' },
    ],
  },
  {
    heading: 'Members & groups',
    items: [
      { label: 'Invite members', action: 'member.invite' },
      { label: 'Change member roles', action: 'member.update' },
      { label: 'Remove members', action: 'member.remove' },
      { label: 'Grant super-admin', action: 'member.super_admin.grant' },
      { label: 'Create groups', action: 'group.create' },
      { label: 'Manage policies', action: 'policy.create' },
    ],
  },
  {
    heading: 'Projects',
    items: [
      { label: 'Create projects', action: 'project.create' },
      { label: 'Read every project', action: 'project.read' },
      { label: 'Write every project', action: 'project.write' },
      { label: 'Delete every project', action: 'project.delete' },
    ],
  },
];

// Flat list of every capability we probe, in display order. The card uses
// this to build a single batch request; the grouped layout below picks
// each row out by index via FLAT_CAPABILITIES.
const FLAT_CAPABILITIES = CAPABILITY_GROUPS.flatMap((g) => g.items);

function CapabilitiesCard({
  accountId,
  memberUserId,
}: {
  accountId: string;
  memberUserId: string;
}) {
  // Stable probe list — declared at module scope so the hook's queryKey is
  // identical across renders. One HTTP roundtrip resolves all 14.
  const results = usePermissionsFor(
    accountId,
    memberUserId,
    FLAT_CAPABILITIES.map((c) => ({ action: c.action })),
  );

  // Build a quick lookup keyed by action so the grouped render finds its
  // result without re-walking the array per row.
  const byAction = new Map(
    FLAT_CAPABILITIES.map((c, i) => [c.action, results[i]] as const),
  );

  return (
    <SectionCard
      title="What this member can do"
      description="Computed by the IAM engine — sum of explicit policies, group inheritance, super-admin bypass, and legacy role bridges."
      flush
    >
      <div className="divide-y divide-border/60">
        {CAPABILITY_GROUPS.map((group) => (
          <div key={group.heading} className="px-6 py-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {group.heading}
            </p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {group.items.map((item) => {
                const probe = byAction.get(item.action);
                return (
                  <CapabilityRow
                    key={item.action}
                    label={item.label}
                    allowed={probe?.allowed ?? false}
                    isLoading={probe?.isLoading ?? true}
                    reason={probe?.reason ?? null}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function CapabilityRow({
  label,
  allowed,
  isLoading,
  reason,
}: {
  label: string;
  allowed: boolean;
  isLoading: boolean;
  reason: string | null;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 text-sm"
      title={reason ? `Reason: ${reason}` : undefined}
    >
      <span className="truncate text-foreground">{label}</span>
      {isLoading ? (
        <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-muted-foreground/20" />
      ) : allowed ? (
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Check className="h-3 w-3" />
        </span>
      ) : (
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <X className="h-3 w-3" />
        </span>
      )}
    </div>
  );
}

// ─── Member groups card ───────────────────────────────────────────────────
// Lists which account groups this member belongs to. Each chip is a link to
// the group detail page so admins can jump straight to "what policies does
// this group grant?" without rebuilding the mental model.

function MemberGroupsCard({
  accountId,
  memberGroups,
  isLoading,
}: {
  accountId: string;
  memberGroups: MemberGroupSummary[];
  isLoading: boolean;
}) {
  const router = useRouter();

  return (
    <SectionCard
      title={`Member of ${memberGroups.length} ${memberGroups.length === 1 ? 'group' : 'groups'}`}
      description="Any policy attached to one of these groups also applies to this member."
      flush
    >
      {isLoading && (
        <div className="px-6 py-4">
          <Skeleton className="h-6 w-48" />
        </div>
      )}

      {!isLoading && memberGroups.length === 0 && (
        <div className="px-6 py-6 text-center">
          <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground">
            <Users className="h-4 w-4" />
          </div>
          <p className="text-sm text-foreground">Not a member of any groups</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Add them to a group to inherit its policies.
          </p>
        </div>
      )}

      {!isLoading && memberGroups.length > 0 && (
        <div className="flex flex-wrap gap-2 px-6 py-4">
          {memberGroups.map((g) => (
            <button
              key={g.group_id}
              type="button"
              onClick={() => router.push(`/accounts/${accountId}/groups/${g.group_id}`)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40"
            >
              <Users className="h-3 w-3 text-muted-foreground" />
              {g.name}
            </button>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
