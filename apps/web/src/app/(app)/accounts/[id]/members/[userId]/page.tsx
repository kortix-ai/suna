'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Eye, FolderOpen, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import {
  listMemberGroups,
  listMemberProjectAccess,
  setMemberSuperAdmin,
  type MemberGroupSummary,
  type MemberProjectAccess,
} from '@/lib/iam-client';
import { errorToast, successToast } from '@/components/ui/toast';
import { getAccount, listAccountMembers, type AccountRole } from '@kortix/sdk/projects-client';
import { usePermission, usePermissionsFor } from '@/lib/use-permission';
import { cn } from '@/lib/utils';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const PANEL = 'bg-popover rounded-md border';

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function MemberDetailPage() {
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
  // "Groups" section so admins can see at a glance which policies the user
  // inherits via group attachments.
  const memberGroupsQuery = useQuery({
    queryKey: ['member-groups', accountId, memberUserId],
    queryFn: () => listMemberGroups(accountId!, memberUserId!),
    enabled: !!user && !!accountId && !!memberUserId,
    staleTime: 30_000,
  });

  const setSuperAdminMutation = useMutation({
    mutationFn: (next: boolean) => setMemberSuperAdmin(accountId!, memberUserId!, next),
    onSuccess: (res) => {
      successToast(res.is_super_admin ? 'Granted super-admin' : 'Revoked super-admin');
      queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
      setGrantConfirmOpen(false);
      setRevokeConfirmOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update'),
  });

  // All hooks MUST be called before any conditional return (rules of
  // hooks). useMemo + usePermission live above the auth-loading guard.
  const member = useMemo(
    () => (membersQuery.data ?? []).find((m) => m.user_id === memberUserId),
    [membersQuery.data, memberUserId],
  );
  // canPromoteSuperAdmin gates the bypass toggle below.
  const canPromoteSuperAdmin = usePermission(accountId, 'member.super_admin.grant').allowed;
  void canPromoteSuperAdmin;

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;

  // Note: we don't currently surface is_super_admin in listAccountMembers, so
  // we can't show a pre-existing on/off state. Wire the column once the
  // members endpoint includes it.

  const memberLabel = member?.email ?? memberUserId ?? 'Member';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 pb-10">
      <div className="space-y-5">
        <Link
          href={`/accounts/${accountId}`}
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm transition-colors"
        >
          <ChevronLeft className="size-4" />
          {account?.name ?? 'Account'}
        </Link>

        <div className="flex min-w-0 items-center gap-3.5">
          {membersQuery.isLoading ? (
            <Skeleton className="size-10 rounded-full" />
          ) : (
            <UserAvatar email={memberLabel} name={member?.email ?? undefined} size="lg" />
          )}
          <div className="min-w-0 space-y-0.5">
            {membersQuery.isLoading ? (
              <Skeleton className="h-6 w-52" />
            ) : (
              <h2 className="text-foreground truncate text-xl font-medium">{memberLabel}</h2>
            )}
            {member ? (
              <InlineMeta className="text-sm">
                <span>{ROLE_LABEL[member.account_role] ?? member.account_role}</span>
                <span>Joined {formatDate(member.joined_at)}</span>
              </InlineMeta>
            ) : null}
          </div>
        </div>
      </div>

      {membersQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load member"
          description={(membersQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => membersQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {!membersQuery.isLoading && !member && memberUserId ? (
        <InfoBanner tone="neutral">This user is not a member of this account.</InfoBanner>
      ) : null}

      {account && member ? (
        <MemberGroupsCard
          accountId={account.account_id}
          memberGroups={memberGroupsQuery.data ?? []}
          isLoading={memberGroupsQuery.isLoading}
        />
      ) : null}

      {account && member ? (
        <MemberProjectAccessCard
          accountId={account.account_id}
          memberUserId={member.user_id}
          accountRole={member.account_role}
        />
      ) : null}

      {account && member ? (
        <CapabilitiesCard accountId={account.account_id} memberUserId={member.user_id} />
      ) : null}

      <ConfirmDialog
        open={grantConfirmOpen}
        onOpenChange={setGrantConfirmOpen}
        title="Grant super-admin"
        description={
          <span>
            Super-admin bypasses every permission check. <strong>{memberLabel}</strong> will be
            able to do anything in this account.
          </span>
        }
        confirmLabel="Grant super-admin"
        isPending={setSuperAdminMutation.isPending}
        onConfirm={() => setSuperAdminMutation.mutate(true)}
      />

      <ConfirmDialog
        open={revokeConfirmOpen}
        onOpenChange={setRevokeConfirmOpen}
        title="Revoke super-admin"
        description={
          <span>
            <strong>{memberLabel}</strong> will lose the bypass. Every action goes through the
            normal permission checks again.
          </span>
        }
        confirmLabel="Revoke super-admin"
        isPending={setSuperAdminMutation.isPending}
        onConfirm={() => setSuperAdminMutation.mutate(false)}
      />

      {account && member ? (
        <ViewAsUserDialog
          open={viewAsOpen}
          onOpenChange={setViewAsOpen}
          accountId={account.account_id}
          memberUserId={member.user_id}
          memberLabel={memberLabel}
        />
      ) : null}
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
  const byAction = new Map(FLAT_CAPABILITIES.map((c, i) => [c.action, results[i]] as const));

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>What this member can do</Label>
        <p className="text-muted-foreground text-xs">
          Computed from their role, groups, and policies.
        </p>
      </div>
      <div className={cn(PANEL, 'divide-border divide-y')}>
        {CAPABILITY_GROUPS.map((group) => (
          <div key={group.heading} className="px-4 py-4">
            <p className="text-muted-foreground mb-2 text-xs font-medium">{group.heading}</p>
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
    </section>
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
      <span className="text-foreground truncate">{label}</span>
      {isLoading ? (
        <span className="bg-muted-foreground/20 size-3.5 animate-pulse rounded-full" />
      ) : allowed ? (
        <span className="bg-kortix-green/15 text-kortix-green inline-flex size-5 items-center justify-center rounded-full">
          <Check className="size-3" />
        </span>
      ) : (
        <span className="bg-muted text-muted-foreground inline-flex size-5 items-center justify-center rounded-full">
          <X className="size-3" />
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
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>
          Groups{memberGroups.length > 0 ? ` · ${memberGroups.length}` : ''}
        </Label>
        <p className="text-muted-foreground text-xs">
          Any policy attached to one of these groups also applies to this member.
        </p>
      </div>
      <div className={PANEL}>
        {isLoading ? (
          <div className="px-4 py-4">
            <Skeleton className="h-6 w-48" />
          </div>
        ) : memberGroups.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="bg-muted text-muted-foreground mx-auto mb-2 flex size-9 items-center justify-center rounded-sm">
              <Users className="size-4" />
            </div>
            <p className="text-foreground text-sm">Not in any groups</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Add them to a group to inherit its policies.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 px-4 py-4">
            {memberGroups.map((g) => (
              <button
                key={g.group_id}
                type="button"
                onClick={() => router.push(`/accounts/${accountId}/groups/${g.group_id}`)}
                className="border-border text-foreground hover:bg-accent inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              >
                <Users className="text-muted-foreground size-3" />
                {g.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── V2: Projects this member can reach ───────────────────────────────────

const PROJECT_ROLE_RANK = { manager: 3, editor: 2, member: 1 } as const;
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
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>Projects{items.length > 0 ? ` · ${items.length}` : ''}</Label>
        <p className="text-muted-foreground text-xs">
          {isAdminLike
            ? `${accountRole === 'owner' ? 'Owners' : 'Admins'} are implicit Manager on every active project in the account.`
            : 'Projects this member can reach via direct grants or groups they belong to.'}
        </p>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-10 w-full rounded-md" />
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load project access"
          description={(query.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <div className={cn(PANEL, 'text-muted-foreground px-4 py-4 text-xs')}>
          No project access.
        </div>
      ) : (
        <div className={cn(PANEL, 'divide-border divide-y overflow-hidden')}>
          {items
            .slice()
            .sort(
              (a, b) =>
                PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role] ||
                a.project_name.localeCompare(b.project_name),
            )
            .map((p) => (
              <button
                key={p.project_id}
                type="button"
                onClick={() => router.push(`/projects/${p.project_id}`)}
                className="hover:bg-accent flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors"
              >
                <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                <span className="text-foreground flex-1 truncate text-sm font-medium">
                  {p.project_name}
                </span>
                <Badge variant="outline" size="sm" className="font-normal capitalize">
                  {p.role}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  via {p.sources.map((s) => SOURCE_LABEL[s]).join(' + ')}
                </span>
              </button>
            ))}
        </div>
      )}
    </section>
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
//      of common admin / project actions, renders allowed / denied
//      with the engine's reason text underneath denials.
//
// No backend changes — the /effective:batch endpoint already supports
// arbitrary user_id targets (gated by member.read on the caller).

const SIMULATOR_PROBES: Array<{
  action: string;
  label: string;
  group: 'Account' | 'Projects' | 'Audit';
}> = [
  { action: 'account.write', label: 'Change account settings', group: 'Account' },
  { action: 'member.invite', label: 'Invite members', group: 'Account' },
  { action: 'member.remove', label: 'Remove members', group: 'Account' },
  { action: 'group.create', label: 'Create groups', group: 'Account' },
  { action: 'group.delete', label: 'Delete groups', group: 'Account' },
  { action: 'project.create', label: 'Create projects', group: 'Projects' },
  { action: 'project.write', label: 'Edit projects', group: 'Projects' },
  { action: 'project.delete', label: 'Delete projects', group: 'Projects' },
  { action: 'project.members.manage', label: 'Manage project members', group: 'Projects' },
  { action: 'audit.read', label: 'View the audit log', group: 'Audit' },
  { action: 'audit.export', label: 'Export audit events', group: 'Audit' },
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

  const probes = useMemo(() => SIMULATOR_PROBES.map((p) => ({ action: p.action })), []);
  const results = usePermissionsFor(
    open ? accountId : undefined,
    open ? memberUserId : undefined,
    probes,
  );
  const grouped = useMemo(() => {
    const groups: Record<
      string,
      Array<{ label: string; allowed: boolean; reason: string | null; isLoading: boolean }>
    > = {};
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
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2">
            <Eye className="text-muted-foreground size-4" />
            Viewing as {memberLabel}
          </ModalTitle>
          <ModalDescription>
            Read-only preview of what this member can do. Nothing is changed.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          {(['Account', 'Projects', 'Audit'] as const).map((sectionName) => (
            <section key={sectionName} className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-medium">{sectionName}</p>
              <ul className="divide-border bg-popover divide-y rounded-md border">
                {(grouped[sectionName] ?? []).map((row) => (
                  <li key={row.label} className="flex items-start gap-3 px-3 py-2 text-sm">
                    <span className="mt-0.5 shrink-0">
                      {row.isLoading ? (
                        <span className="bg-muted block size-3.5 animate-pulse rounded-full" />
                      ) : row.allowed ? (
                        <Check className="text-kortix-green size-3.5" />
                      ) : (
                        <X className="text-kortix-red size-3.5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground">{row.label}</p>
                      {!row.allowed && row.reason && !row.isLoading ? (
                        <p className="text-muted-foreground text-xs">{row.reason}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="text-muted-foreground text-xs">
            Project-by-project access is listed in the Projects section on the member page.
          </p>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
