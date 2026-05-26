'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  Eye,
  FolderOpen,
  Shield,
  ShieldOff,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import {
  listMemberGroups,
  listMemberProjectAccess,
  setMemberSuperAdmin,
  type MemberGroupSummary,
  type MemberProjectAccess,
} from '@/lib/iam-client';
import { getAccount, listAccountMembers, type AccountRole } from '@/lib/projects-client';
import { usePermission, usePermissionsFor } from '@/lib/use-permission';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export default function MemberDetailPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const params = useParams<{ id: string; userId: string }>();
  const accountId = params?.id;
  const memberUserId = params?.userId;
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const [grantConfirmOpen, setGrantConfirmOpen] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);

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
  // canPromoteSuperAdmin gates the bypass toggle below.
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
              {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line120JsxTextBackToProjects')}</button>
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
              <div className="flex items-center gap-1.5">
                {member && memberUserId !== user.id && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setViewAsOpen(true)}
                    className="gap-1.5"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    View as
                  </Button>
                )}
              {canPromoteSuperAdmin && memberUserId !== user.id && member?.is_super_admin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevokeConfirmOpen(true)}
                  className="gap-1.5"
                  disabled={setSuperAdminMutation.isPending}
                >
                  <ShieldOff className="h-3.5 w-3.5" />
                  {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line184JsxTextRevokeSuperAdmin')}</Button>
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
                  {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line196JsxTextGrantSuperAdmin')}</Button>
              )}
              </div>
            </div>
          </div>

          {membersQuery.isError && (
            <InfoBanner tone="destructive" title={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line203JsxAttrTitleFailedToLoadMember')}>
              {(membersQuery.error as Error).message}
            </InfoBanner>
          )}

          {!membersQuery.isLoading && !member && memberUserId && (
            <InfoBanner tone="neutral">
              {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line210JsxTextThisUserIsNotAMemberOfThis')}</InfoBanner>
          )}

          {account && member && (
            <MemberGroupsCard
              accountId={account.account_id}
              memberGroups={memberGroupsQuery.data ?? []}
              isLoading={memberGroupsQuery.isLoading}
            />
          )}

          {account && member && (
            <MemberProjectAccessCard
              accountId={account.account_id}
              memberUserId={member.user_id}
              accountRole={member.account_role}
            />
          )}

          {account && member && (
            <CapabilitiesCard
              accountId={account.account_id}
              memberUserId={member.user_id}
            />
          )}

          <ConfirmDialog
            open={grantConfirmOpen}
            onOpenChange={setGrantConfirmOpen}
            title={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line250JsxAttrTitleGrantSuperAdmin')}
            description={
              <span>
                {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line253JsxTextSuperAdminBypassesEveryIAMCheck')}<strong>{memberLabel}</strong> {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line253JsxTextWillBeAbleToDoAnythingInThis')}</span>
            }
            confirmLabel={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line258JsxAttrConfirmLabelGrantSuperAdmin')}
            isPending={setSuperAdminMutation.isPending}
            onConfirm={() => setSuperAdminMutation.mutate(true)}
          />

          <ConfirmDialog
            open={revokeConfirmOpen}
            onOpenChange={setRevokeConfirmOpen}
            title={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line266JsxAttrTitleRevokeSuperAdmin')}
            description={
              <span>
                <strong>{memberLabel}</strong> {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line269JsxTextWillLoseTheBypassFromNowOnEvery')}</span>
            }
            confirmLabel={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line274JsxAttrConfirmLabelRevokeSuperAdmin')}
            isPending={setSuperAdminMutation.isPending}
            onConfirm={() => setSuperAdminMutation.mutate(false)}
          />

          {account && member && (
            <ViewAsUserDialog
              open={viewAsOpen}
              onOpenChange={setViewAsOpen}
              accountId={account.account_id}
              memberUserId={member.user_id}
              memberLabel={memberLabel}
            />
          )}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      title={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line353JsxAttrTitleWhatThisMemberCanDo')}
      description={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line354JsxAttrDescriptionComputedByTheIAMEngineSumOfExplicit')}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();

  return (
    <SectionCard
      title={`Member of ${memberGroups.length} ${memberGroups.length === 1 ? 'group' : 'groups'}`}
      description={tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line435JsxAttrDescriptionAnyPolicyAttachedToOneOfTheseGroups')}
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
          <p className="text-sm text-foreground">{tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line449JsxTextNotAMemberOfAnyGroups')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tHardcodedUi.raw('appAccountsIdMembersUserIdPage.line451JsxTextAddThemToAGroupToInheritIts')}</p>
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

// ─── V2: Projects this member can reach ───────────────────────────────────

const PROJECT_ROLE_RANK = { manager: 3, editor: 2, viewer: 1 } as const;
const SOURCE_LABEL: Record<MemberProjectAccess['sources'][number], string> = {
  implicit: 'Account admin',
  direct: 'Direct',
  group: 'Group',
};

function MemberProjectAccessCard({
  accountId,
  memberUserId,
  accountRole,
}: {
  accountId: string;
  memberUserId: string;
  accountRole: AccountRole;
}) {
  const router = useRouter();
  const query = useQuery({
    queryKey: ['iam-member-project-access', accountId, memberUserId],
    queryFn: () => listMemberProjectAccess(accountId, memberUserId),
    staleTime: 30_000,
  });
  const items = query.data ?? [];
  const isAdminLike = accountRole === 'owner' || accountRole === 'admin';

  return (
    <SectionCard
      title="Project access"
      description={
        isAdminLike
          ? `${accountRole === 'owner' ? 'Owners' : 'Admins'} are implicit Manager on every active project in the account.`
          : 'Projects this member can reach via direct grants or groups they belong to.'
      }
      count={items.length}
    >
      {query.isLoading && <Skeleton className="h-10 w-full" />}

      {!query.isLoading && query.isError && (
        <InfoBanner
          tone="destructive"
          title="Failed to load project access"
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        >
          {(query.error as Error)?.message}
        </InfoBanner>
      )}

      {!query.isLoading && !query.isError && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No project access yet. Add this member to a project directly from the project&apos;s
          Members page, or to a group that&apos;s attached to one.
        </p>
      )}

      {!query.isLoading && items.length > 0 && (
        <ul className="divide-y divide-border/60 -mx-6">
          {items
            .slice()
            .sort(
              (a, b) =>
                PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role] ||
                a.project_name.localeCompare(b.project_name),
            )
            .map((p) => (
              <li key={p.project_id}>
                <button
                  type="button"
                  onClick={() => router.push(`/projects/${p.project_id}`)}
                  className="flex w-full cursor-pointer items-center gap-3 px-6 py-2.5 text-left transition-colors hover:bg-muted/40"
                >
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-sm font-medium text-foreground">
                    {p.project_name}
                  </span>
                  <Badge
                    variant="outline"
                    size="sm"
                    className="capitalize text-[10px] font-normal"
                  >
                    {p.role}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    via {p.sources.map((s) => SOURCE_LABEL[s]).join(' + ')}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ─── View-as / permission simulator ───────────────────────────────────────
//
// Read-only "what would this user see?" — answers the question without
// requiring the admin to impersonate. Two sections:
//
//   1. Project access — reuses listMemberProjectAccess (already
//      surfaced on the member card above, repeated here for one-screen
//      answer + because the dialog should be self-contained).
//   2. Capabilities — fans out usePermissionsFor against a curated set
//      of common admin / project actions, renders ✅ allowed / ❌ denied
//      with the engine's reason text underneath denials.
//
// No backend changes — the /effective:batch endpoint already supports
// arbitrary user_id targets (gated by member.read on the caller).

const SIMULATOR_PROBES: Array<{
  action: string;
  label: string;
  group: 'Account' | 'Projects' | 'Audit';
}> = [
  { action: 'account.write',           label: 'Change account settings',  group: 'Account' },
  { action: 'member.invite',           label: 'Invite members',           group: 'Account' },
  { action: 'member.remove',           label: 'Remove members',           group: 'Account' },
  { action: 'group.create',            label: 'Create groups',            group: 'Account' },
  { action: 'group.delete',            label: 'Delete groups',            group: 'Account' },
  { action: 'project.create',          label: 'Create projects',          group: 'Projects' },
  { action: 'project.write',           label: 'Edit projects',            group: 'Projects' },
  { action: 'project.delete',          label: 'Delete projects',          group: 'Projects' },
  { action: 'project.members.manage',  label: 'Manage project members',   group: 'Projects' },
  { action: 'audit.read',              label: 'View the audit log',       group: 'Audit' },
  { action: 'audit.export',            label: 'Export audit events',      group: 'Audit' },
];

function ViewAsUserDialog({
  open,
  onOpenChange,
  accountId,
  memberUserId,
  memberLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  memberUserId: string;
  memberLabel: string;
}) {
  // Only probe when the dialog is open (saves the round-trip for
  // admins who never click View as). Probes intentionally exclude
  // resource-scoped actions like project.write on project X — the
  // V2 engine answers "can they perform this action on the account"
  // which is the question this dialog should answer; per-project
  // breakdown is the job of the MemberProjectAccessCard above.
  const probes = useMemo(
    () => SIMULATOR_PROBES.map((p) => ({ action: p.action })),
    [],
  );
  const results = usePermissionsFor(
    open ? accountId : undefined,
    open ? memberUserId : undefined,
    probes,
  );
  const grouped = useMemo(() => {
    const groups: Record<string, Array<{ label: string; allowed: boolean; reason: string | null; isLoading: boolean }>> = {};
    SIMULATOR_PROBES.forEach((p, i) => {
      const r = results[i];
      if (!groups[p.group]) groups[p.group] = [];
      groups[p.group].push({
        label: p.label,
        allowed: !!r?.allowed,
        reason: r?.reason ?? null,
        isLoading: !!r?.isLoading,
      });
    });
    return groups;
  }, [results]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            Viewing as {memberLabel}
          </DialogTitle>
          <DialogDescription>
            Read-only check of what this member can do across the
            account. The engine answers in real time — same logic the
            UI uses to gate buttons for the user themselves.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {(['Account', 'Projects', 'Audit'] as const).map((sectionName) => (
            <section key={sectionName} className="space-y-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                {sectionName}
              </h3>
              <ul className="divide-y divide-border/40 rounded-md border border-border/60">
                {(grouped[sectionName] ?? []).map((row) => (
                  <li
                    key={row.label}
                    className="flex items-start gap-3 px-3 py-2 text-sm"
                  >
                    <span className="mt-0.5 shrink-0">
                      {row.isLoading ? (
                        <span className="block h-3.5 w-3.5 animate-pulse rounded-full bg-muted" />
                      ) : row.allowed ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <X className="h-3.5 w-3.5 text-rose-500" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground">{row.label}</p>
                      {!row.allowed && row.reason && !row.isLoading && (
                        <p className="text-[11px] text-muted-foreground">
                          {row.reason}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="text-[11px] text-muted-foreground">
            Project-scoped access (which projects they can reach + at
            what role) is shown in the Project access card on this
            page. This dialog is the account-wide capability view.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
