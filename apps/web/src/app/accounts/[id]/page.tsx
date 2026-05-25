'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  Github,
  KeyRound,
  Link as LinkIcon,
  Loader2,
  Mail,
  MoreHorizontal,
  RefreshCw,
  Shield,
  Trash2,
  Unplug,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { InlineMeta } from '@/components/ui/inline-meta';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { SectionCard } from '@/components/ui/section-card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupsTab } from '@/components/iam/groups-tab';
import { RolesTab } from '@/components/iam/roles-tab';
import { AuditTab } from '@/components/iam/audit-tab';
import { AnalyticsCard } from '@/components/iam/analytics-card';
import { DriftCard } from '@/components/iam/drift-card';
import { StrictModeCard } from '@/components/iam/strict-mode-card';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { SsoCard } from '@/components/iam/sso-card';
import { SessionControlsCard } from '@/components/iam/session-controls-card';
import { PatPolicyCard } from '@/components/iam/pat-policy-card';
import { ApprovalsCard } from '@/components/iam/approvals-card';
import { ProjectGroupsCard } from '@/components/iam/project-groups-card';
import { ServiceAccountsCard } from '@/components/iam/service-accounts-card';
import { BreakGlassCard } from '@/components/iam/break-glass-card';
import { ExternalGrantsCard } from '@/components/iam/external-grants-card';
import { ScimCard } from '@/components/iam/scim-card';
import { AuditWebhooksCard } from '@/components/iam/audit-webhooks-card';
import { usePermission } from '@/lib/use-permission';
import { useIamV2Enabled } from '@/lib/use-iam-version';
import {
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type AccountRole,
  cancelAccountInvite,
  deleteGitHubInstallation,
  getAccount,
  inviteAccountMember,
  leaveAccount,
  listAccountInvites,
  listGitHubInstallations,
  listAccountMembers,
  removeAccountMember,
  resendAccountInvite,
  updateAccountMemberRole,
  updateAccountName,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';

const ROLE_LABEL: Record<AccountRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function memberLabel(member: Pick<AccountMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

/** Copy an invite URL to the clipboard with a friendly toast either way. */
async function copyInviteLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Invite link copied to clipboard');
  } catch {
    // Older browsers / blocked clipboard — show the link in a toast so the
    // admin can copy it by hand.
    toast.message('Copy this invite link', {
      description: url,
      duration: 15_000,
    });
  }
}

function rememberGitHubSetupReturn(path: string) {
  try {
    window.localStorage.setItem('kortix:github_setup_return', path);
  } catch {
    // Non-critical: the setup page falls back to the project import flow.
  }
}

export default function AccountSettingsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const accountId = params?.id;
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

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

  // Granular capabilities sourced from the IAM engine instead of raw
  // account_role. A member granted "Administrator" via an explicit policy
  // gets the same affordances an owner does, and vice-versa. MUST be
  // called before any conditional return — moving these below the
  // auth-loading guard would change the hook count between renders.
  // usePermission internally short-circuits when accountId is falsy, so
  // it's safe to call before the account query resolves.
  // V2-vs-V1 dispatch for the UI surface. When the account is on V2 we
  // hide the Roles tab + the V1-only Audit panels (analytics, drift)
  // because those concepts only exist in the policy-based engine.
  const { enabled: isIamV2 } = useIamV2Enabled(accountId);
  const canWriteAccount = usePermission(accountId, 'account.write').allowed;
  const canDeleteAccount = usePermission(accountId, 'account.delete').allowed;
  const canInviteMember = usePermission(accountId, 'member.invite').allowed;
  const canRemoveMember = usePermission(accountId, 'member.remove').allowed;
  const canUpdateMember = usePermission(accountId, 'member.update').allowed;
  const canCreateGroup = usePermission(accountId, 'group.create').allowed;
  const canCreateRole = usePermission(accountId, 'role.create').allowed;
  const canReadAudit = usePermission(accountId, 'audit.read').allowed;

  if (authLoading || !user) {
    return (
      <ConnectingScreen
        forceConnecting
        overrideStage="auth"
        hideWorkspacePicker
      />
    );
  }

  const account = accountQuery.data;
  const members = membersQuery.data ?? [];
  const initialTab = searchParams.get('tab') === 'git' ? 'git' : 'members';
  const isTeam = account ? !account.personal_account : false;

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
              <ArrowLeft className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line197JsxTextBackToProjects')}</button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => router.push('/accounts')}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                Accounts
              </button>
              <span className="text-muted-foreground/40">/</span>
              {accountQuery.isLoading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <span className="truncate font-medium text-foreground">
                  {account?.name ?? 'Account'}
                </span>
              )}
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {accountQuery.isLoading ? (
                  <Skeleton className="h-7 w-48" />
                ) : (
                  account?.name
                )}
              </h1>
              {account && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Manage account settings, members, and access.
                </p>
              )}
            </div>
          </div>

          {accountQuery.isError && (
            <InfoBanner
              tone="destructive"
              title={tHardcodedUi.raw('appAccountsIdPage.line237JsxAttrTitleFailedToLoadAccount')}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => accountQuery.refetch()}
                >
                  Retry
                </Button>
              }
            >
              {(accountQuery.error as Error).message}
            </InfoBanner>
          )}

          {accountQuery.isLoading && (
            <>
              <Skeleton className="h-48 w-full rounded-2xl" />
              <Skeleton className="h-64 w-full rounded-2xl" />
            </>
          )}

          {account && (
            <Tabs defaultValue={initialTab} className="space-y-6">
              <TabsList>
                <TabsTrigger value="members">{tHardcodedUi.raw('appAccountsIdPage.line262JsxTextAllMembers')}</TabsTrigger>
                <TabsTrigger value="groups">Groups</TabsTrigger>
                {!isIamV2 && <TabsTrigger value="roles">Roles</TabsTrigger>}
                <TabsTrigger value="git">Git</TabsTrigger>
                {canReadAudit && <TabsTrigger value="audit">Audit</TabsTrigger>}
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>

              <TabsContent value="members" className="space-y-6">
                <MembersCard
                  account={account}
                  members={members}
                  isLoading={membersQuery.isLoading}
                  isError={membersQuery.isError}
                  error={membersQuery.error as Error | null}
                  onRetry={() => membersQuery.refetch()}
                  queryClient={queryClient}
                  currentUserId={user.id}
                  canInvite={canInviteMember}
                  canRemove={canRemoveMember}
                  canUpdateRole={canUpdateMember}
                />
              </TabsContent>

              <TabsContent value="groups" className="space-y-6">
                <GroupsTab
                  accountId={account.account_id}
                  canCreate={canCreateGroup}
                />
              </TabsContent>

              {!isIamV2 && (
                <TabsContent value="roles" className="space-y-6">
                  <RolesTab
                    accountId={account.account_id}
                    canCreate={canCreateRole}
                  />
                </TabsContent>
              )}

              {canReadAudit && (
                <TabsContent value="audit" className="space-y-6">
                  {!isIamV2 && (
                    <>
                      <AnalyticsCard accountId={account.account_id} />
                      <DriftCard accountId={account.account_id} />
                    </>
                  )}
                  <AuditTab accountId={account.account_id} />
                </TabsContent>
              )}

              <TabsContent value="git" className="space-y-6">
                <GitHubConnectionCard
                  account={account}
                  canManage={canWriteAccount}
                />
              </TabsContent>

              <TabsContent value="settings" className="space-y-6">
                <GeneralCard
                  account={account}
                  queryClient={queryClient}
                  canWrite={canWriteAccount}
                />
                {/* Strict mode toggles V1's legacy bridges. V2 has no
                    bridges to toggle, so the card is meaningless there. */}
                {!isIamV2 && (
                  <StrictModeCard
                    accountId={account.account_id}
                    canManage={canWriteAccount}
                  />
                )}
                <MfaRequiredCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                <SsoCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                <SessionControlsCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                <PatPolicyCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                {/* Approval workflows gate policy mutations. V2 has no
                    policies, so the queue is always empty here. */}
                {!isIamV2 && (
                  <ApprovalsCard
                    accountId={account.account_id}
                    currentUserId={user.id}
                    canManage={canWriteAccount}
                  />
                )}
                {/* Project groups (resource groups) only exist in V1's
                    scope grammar. V2 attaches account_groups to projects
                    directly via the project Members page. */}
                {!isIamV2 && (
                  <ProjectGroupsCard
                    accountId={account.account_id}
                    canManage={canWriteAccount}
                  />
                )}
                <ServiceAccountsCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                {/* Break-glass grants are a V1 super-admin escalation
                    surface. V2 uses the is_super_admin flag directly. */}
                {!isIamV2 && (
                  <BreakGlassCard
                    accountId={account.account_id}
                    currentUserId={user.id}
                    canManage={canWriteAccount}
                  />
                )}
                {/* Cross-account sharing via "external" members is a V1
                    feature that V2 doesn't model. */}
                {!isIamV2 && (
                  <ExternalGrantsCard
                    accountId={account.account_id}
                    canManage={canWriteAccount}
                  />
                )}
                <ScimCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                <AuditWebhooksCard
                  accountId={account.account_id}
                  canManage={canWriteAccount}
                />
                {isTeam && canDeleteAccount && <DangerZoneCard />}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </main>
    </div>
  );
}

// ============================== GENERAL ==============================

function GitHubConnectionCard({
  account,
  canManage,
}: {
  account: AccountDetail;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [disconnectTarget, setDisconnectTarget] = useState<{
    installationId: string;
    ownerLogin: string | null;
  } | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const installationsQuery = useQuery({
    queryKey: ['github-installations', account.account_id],
    queryFn: () => listGitHubInstallations(account.account_id),
    staleTime: 0,
  });

  const disconnectMutation = useMutation({
    mutationFn: (installationId: string) =>
      deleteGitHubInstallation(account.account_id, installationId),
    onSuccess: () => {
      toast.success('GitHub disconnected');
      setDisconnectTarget(null);
      queryClient.invalidateQueries({
        queryKey: ['github-installations', account.account_id],
      });
      queryClient.invalidateQueries({
        queryKey: ['github-repositories', account.account_id],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to disconnect GitHub'),
  });

  async function handleConnect() {
    if (!canManage) return;
    setIsConnecting(true);
    try {
      const result = await installationsQuery.refetch();
      if (result.error) throw result.error;
      const installUrl = result.data?.install_url;
      if (!installUrl) {
        toast.error(
          result.data?.configured === false
            ? 'GitHub App is not configured'
            : 'GitHub install URL unavailable',
        );
        return;
      }
      rememberGitHubSetupReturn(`/accounts/${account.account_id}?tab=git`);
      window.location.assign(installUrl);
    } catch (err) {
      toast.error((err as Error).message || 'Failed to start GitHub setup');
    } finally {
      setIsConnecting(false);
    }
  }

  const installations = installationsQuery.data?.installations ?? [];

  return (
    <>
      <SectionCard
        title={tHardcodedUi.raw('appAccountsIdPage.line397JsxAttrTitleGitConnections')}
        count={installations.length}
        description={tHardcodedUi.raw('appAccountsIdPage.line399JsxAttrDescriptionConnectOneOrMoreGithubUsersOrOrganizations')}
        action={
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!canManage || isConnecting}
            onClick={handleConnect}
            title={
              canManage
                ? undefined
                : 'You do not have permission to connect GitHub.'
            }
          >
            {isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Github className="h-4 w-4" />
            )}
            {isConnecting ? 'Connecting' : 'Connect GitHub'}
          </Button>
        }
        flush
      >
        {installationsQuery.isLoading ? (
          <List>
            <li className="flex items-center gap-3 px-6 py-3">
              <Skeleton className="size-8 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-56" />
              </div>
            </li>
          </List>
        ) : installationsQuery.isError ? (
          <div className="px-6 py-5">
            <InfoBanner
              tone="warning"
              icon={Github}
              title={tHardcodedUi.raw('appAccountsIdPage.line438JsxAttrTitleGithubStatusUnavailable')}
            >
              {(installationsQuery.error as Error).message}
            </InfoBanner>
          </div>
        ) : installations.length === 0 ? (
          <EmptyState
            icon={Github}
            title={tHardcodedUi.raw('appAccountsIdPage.line446JsxAttrTitleNoGithubConnections')}
            description={tHardcodedUi.raw('appAccountsIdPage.line447JsxAttrDescriptionConnectTheKortixGithubAppToImportRepositories')}
            action={
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                disabled={!canManage || isConnecting}
                onClick={handleConnect}
              >
                {isConnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Github className="h-4 w-4" />
                )}{tHardcodedUi.raw('appAccountsIdPage.line461JsxTextConnectGithub')}</Button>
            }
          />
        ) : (
          <List>
            {installations.map((installation) => {
              const contentsPermission = permissionLabel(
                installation.permissions?.contents,
              );
              const repoSelection =
                installation.repository_selection === 'selected'
                  ? 'Selected repositories'
                  : installation.repository_selection === 'all'
                    ? 'All repositories'
                    : null;
              const installationId = installation.installation_id ?? '';
              return (
                <ListRow
                  key={installationId || installation.owner_login || 'github'}
                  leading={<EntityAvatar icon={Github} />}
                  title={installation.owner_login ?? 'GitHub App'}
                  badges={
                    <Badge variant="success" size="sm">
                      Connected
                    </Badge>
                  }
                  subtitle={
                    <InlineMeta>
                      {installation.owner_type ? (
                        <span>{installation.owner_type}</span>
                      ) : null}
                      {repoSelection ? <span>{repoSelection}</span> : null}
                      {contentsPermission ? (
                        <span>{contentsPermission}</span>
                      ) : null}
                    </InlineMeta>
                  }
                  trailing={
                    <>
                      {installation.installation_url ? (
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                        >
                          <a
                            href={installation.installation_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Configure
                          </a>
                        </Button>
                      ) : null}
                      {canManage && installationId ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() =>
                            setDisconnectTarget({
                              installationId,
                              ownerLogin: installation.owner_login,
                            })
                          }
                        >
                          <Unplug className="h-3.5 w-3.5" />
                          Disconnect
                        </Button>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </List>
        )}
      </SectionCard>

      <InfoBanner
        tone="neutral"
        icon={Shield}
        title={tHardcodedUi.raw('appAccountsIdPage.line547JsxAttrTitleGitCredentialsArePlatformCredentials')}
      >{tHardcodedUi.raw('appAccountsIdPage.line549JsxTextKortixStoresTheGithubAppInstallationOnThe')}</InfoBanner>

      <ConfirmDialog
        open={Boolean(disconnectTarget)}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
        title={tHardcodedUi.raw('appAccountsIdPage.line558JsxAttrTitleDisconnectGithub')}
        description={`New imports from ${disconnectTarget?.ownerLogin ?? 'this GitHub account'} will stop working until it is connected again. Existing projects keep their repository link.`}
        confirmLabel="Disconnect"
        onConfirm={() => {
          if (disconnectTarget) {
            disconnectMutation.mutate(disconnectTarget.installationId);
          }
        }}
        isPending={disconnectMutation.isPending}
      />
    </>
  );
}

function permissionLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return `Contents ${value}`;
}

function GeneralCard({
  account,
  queryClient,
  canWrite,
}: {
  account: AccountDetail;
  queryClient: ReturnType<typeof useQueryClient>;
  canWrite: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [name, setName] = useState(account.name);

  useEffect(() => {
    setName(account.name);
  }, [account.name]);

  const renameMutation = useMutation({
    mutationFn: (next: string) => updateAccountName(account.account_id, next),
    onSuccess: (updated) => {
      toast.success('Account updated');
      queryClient.setQueryData(['account', account.account_id], updated);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to update account'),
  });

  const trimmed = name.trim();
  const canSubmit = canWrite && trimmed.length > 0 && trimmed !== account.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    renameMutation.mutate(trimmed);
  }

  return (
    <SectionCard
      title="General"
      description={tHardcodedUi.raw('appAccountsIdPage.line615JsxAttrDescriptionBasicInformationAboutThisAccount')}
      flush
    >
      <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="account-name">{tHardcodedUi.raw('appAccountsIdPage.line620JsxTextAccountName')}</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canWrite || renameMutation.isPending}
            maxLength={120}
            className="max-w-md"
            title={
              canWrite
                ? undefined
                : 'You do not have permission to rename this account.'
            }
          />
          {!canWrite && (
            <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appAccountsIdPage.line636JsxTextYouDoNotHavePermissionToRenameThis')}</p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 pt-4">
          <p className="text-xs text-muted-foreground">
            Created {formatDate(account.created_at)}
          </p>
          <Button
            type="submit"
            disabled={!canSubmit || renameMutation.isPending}
            className="gap-1.5"
          >
            {renameMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

// ============================== MEMBERS ==============================

function MembersCard({
  account,
  members,
  isLoading,
  isError,
  error,
  onRetry,
  queryClient,
  currentUserId,
  canInvite,
  canRemove,
  canUpdateRole,
}: {
  account: AccountDetail;
  members: AccountMember[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
  currentUserId: string;
  canInvite: boolean;
  canRemove: boolean;
  canUpdateRole: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AccountMember | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  // canInvite/canRemove/canUpdateRole come in as props (driven by usePermission
  // at the page level). The row-level kebab respects each granularly.

  const sorted = useMemo(() => {
    const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };
    return [...members].sort((a, b) => {
      const r = rank[a.account_role] - rank[b.account_role];
      if (r !== 0) return r;
      return memberLabel(a).localeCompare(memberLabel(b));
    });
  }, [members]);

  const invalidateMembers = () => {
    queryClient.invalidateQueries({
      queryKey: ['account-members', account.account_id],
    });
    queryClient.invalidateQueries({
      queryKey: ['account-invites', account.account_id],
    });
    queryClient.invalidateQueries({
      queryKey: ['account', account.account_id],
    });
  };

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      removeAccountMember(account.account_id, userId),
    onMutate: (userId) => setPendingUserId(userId),
    onSettled: () => setPendingUserId(null),
    onSuccess: () => {
      toast.success('Member removed');
      invalidateMembers();
      setRemoveTarget(null);
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to remove member'),
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AccountRole }) =>
      updateAccountMemberRole(account.account_id, userId, role),
    onMutate: ({ userId }) => setPendingUserId(userId),
    onSettled: () => setPendingUserId(null),
    onSuccess: () => {
      toast.success('Role updated');
      invalidateMembers();
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to update role'),
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveAccount(account.account_id),
    onMutate: () => setPendingUserId(currentUserId),
    onSettled: () => setPendingUserId(null),
    onSuccess: () => {
      toast.success(`Left ${account.name}`);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      router.push('/accounts');
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to leave team'),
  });

  return (
    <SectionCard
      title="Members"
      count={account.member_count}
      description={tHardcodedUi.raw('appAccountsIdPage.line761JsxAttrDescriptionPeopleWithAccessToThisAccount')}
      action={
        canInvite && (
          <Button
            onClick={() => setInviteOpen(true)}
            size="sm"
            className="gap-1.5"
          >
            <UserPlus className="h-4 w-4" />{tHardcodedUi.raw('appAccountsIdPage.line770JsxTextInviteMember')}</Button>
        )
      }
      flush
    >
      {isError && (
        <div className="px-6 py-5">
          <InfoBanner
            tone="destructive"
            title={tHardcodedUi.raw('appAccountsIdPage.line780JsxAttrTitleFailedToLoadMembers')}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          >
            {error?.message}
          </InfoBanner>
        </div>
      )}

      {isLoading && (
        <List>
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-6 py-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-24" />
              </div>
            </li>
          ))}
        </List>
      )}

      {!isLoading && !isError && (
        <PendingInvitesSection
          accountId={account.account_id}
          canManage={canInvite}
        />
      )}

      {!isLoading && !isError && (
        <List>
          {sorted.map((member) => {
            const isSelf = member.user_id === currentUserId;
            const isLastOwner =
              member.account_role === 'owner' &&
              sorted.filter((m) => m.account_role === 'owner').length === 1;
            const pending = pendingUserId === member.user_id;
            // Kebab is always available — "View & Edit permission policies"
            // is open to anyone who can view the member; backend gates writes.
            const showKebab = !pending;

            return (
              <ListRow
                key={member.user_id}
                leading={
                  <UserAvatar
                    email={member.email ?? member.user_id}
                    name={member.email ?? undefined}
                    size="md"
                  />
                }
                title={memberLabel(member)}
                badges={
                  isSelf && (
                    <Badge variant="secondary" size="sm">
                      You
                    </Badge>
                  )
                }
                subtitle={
                  <InlineMeta>
                    <span>Joined {formatDate(member.joined_at)}</span>
                    {member.account_role === 'member' &&
                    typeof member.explicit_project_count === 'number' ? (
                      <span>
                        {member.explicit_project_count} project
                        {member.explicit_project_count === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </InlineMeta>
                }
                trailing={
                  <>
                    <div className="hidden items-center gap-1.5 sm:flex">
                      {member.is_super_admin && (
                        <Badge
                          variant="outline"
                          className="h-5 rounded-md border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300"
                          title={tHardcodedUi.raw('appAccountsIdPage.line924JsxAttrTitleSuperAdminBypassesEveryIAMCheck')}
                        >
                          super
                        </Badge>
                      )}
                      {member.groups && member.groups.length > 0 && (
                        <Badge
                          variant="outline"
                          className="h-5 rounded-md px-1.5 text-[10px] font-normal"
                          title={member.groups.map((g) => g.name).join(', ')}
                        >
                          {member.groups.length} group{member.groups.length === 1 ? '' : 's'}
                        </Badge>
                      )}
                      {typeof member.active_pat_count === 'number' &&
                        member.active_pat_count > 0 && (
                          <Badge
                            variant="outline"
                            className="h-5 rounded-md px-1.5 text-[10px] font-normal"
                            title={`${member.active_pat_count} active PAT${member.active_pat_count === 1 ? '' : 's'}`}
                          >
                            {member.active_pat_count} PAT{member.active_pat_count === 1 ? '' : 's'}
                          </Badge>
                        )}
                      {member.has_verified_mfa && (
                        <Badge
                          variant="outline"
                          className="h-5 rounded-md border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] font-normal text-emerald-700 dark:text-emerald-300"
                          title={tHardcodedUi.raw('appAccountsIdPage.line952JsxAttrTitleMFAEnrolled')}
                        >
                          2FA
                        </Badge>
                      )}
                    </div>
                    <RoleBadge role={member.account_role} />
                    <div className="ml-1 w-7 shrink-0">
                      {pending ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : showKebab ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              aria-label={`Actions for ${memberLabel(member)}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem
                              onSelect={() =>
                                router.push(
                                  `/accounts/${account.account_id}/members/${member.user_id}`,
                                )
                              }
                              className="gap-2"
                            >
                              <KeyRound className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line883JsxTextViewAmpEditPermissionPolicies')}</DropdownMenuItem>
                            {canUpdateRole && !isSelf && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{tHardcodedUi.raw('appAccountsIdPage.line889JsxTextChangeRole')}</DropdownMenuLabel>
                                {(
                                  ['owner', 'admin', 'member'] as AccountRole[]
                                ).map((role) => (
                                  <DropdownMenuItem
                                    key={role}
                                    disabled={role === member.account_role}
                                    onSelect={() =>
                                      roleMutation.mutate({
                                        userId: member.user_id,
                                        role,
                                      })
                                    }
                                    className="gap-2"
                                  >
                                    <Shield className="h-3.5 w-3.5" />
                                    {ROLE_LABEL[role]}
                                    {role === member.account_role && (
                                      <span className="ml-auto text-xs text-muted-foreground">
                                        Current
                                      </span>
                                    )}
                                  </DropdownMenuItem>
                                ))}
                              </>
                            )}
                            {canRemove && !isSelf && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => setRemoveTarget(member)}
                                  disabled={isLastOwner}
                                  className="gap-2"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line925JsxTextRemoveFromTeam')}</DropdownMenuItem>
                              </>
                            )}
                            {isSelf && !account.personal_account && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => setLeaveConfirmOpen(true)}
                                  disabled={isLastOwner}
                                  className="gap-2"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line938JsxTextLeaveTeam')}</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </>
                }
              />
            );
          })}
          {sorted.length === 0 && (
            <li className="px-6 py-8 text-center text-sm text-muted-foreground">{tHardcodedUi.raw('appAccountsIdPage.line953JsxTextNoMembersYet')}</li>
          )}
        </List>
      )}

      <InviteMemberModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        accountId={account.account_id}
        onInvited={invalidateMembers}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title={tHardcodedUi.raw('appAccountsIdPage.line971JsxAttrTitleRemoveMember')}
        description={
          <span>
            Remove{' '}
            <span className="font-medium text-foreground">
              {removeTarget ? memberLabel(removeTarget) : ''}
            </span>{' '}
            from{' '}
            <span className="font-medium text-foreground">{account.name}</span>{tHardcodedUi.raw('appAccountsIdPage.line979JsxTextTheyWillLoseAccessImmediately')}</span>
        }
        confirmLabel="Remove"
        onConfirm={() =>
          removeTarget && removeMutation.mutate(removeTarget.user_id)
        }
        isPending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title={tHardcodedUi.raw('appAccountsIdPage.line993JsxAttrTitleLeaveTeam')}
        description={
          <span>{tHardcodedUi.raw('appAccountsIdPage.line996JsxTextYouAposLlLoseAccessTo')}{' '}
            <span className="font-medium text-foreground">{account.name}</span>{' '}{tHardcodedUi.raw('appAccountsIdPage.line998JsxTextAndItsProjects')}</span>
        }
        confirmLabel="Leave"
        onConfirm={() => leaveMutation.mutate()}
        isPending={leaveMutation.isPending}
      />
    </SectionCard>
  );
}

function RoleBadge({ role }: { role: AccountRole }) {
  return (
    <Badge
      variant={role === 'owner' ? 'outline' : 'secondary'}
      size="sm"
      className={cn(role === 'owner' && 'border-foreground/40 text-foreground')}
    >
      {ROLE_LABEL[role]}
    </Badge>
  );
}

// ============================== INVITE MODAL ==============================

function InviteMemberModal({
  open,
  onOpenChange,
  accountId,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  onInvited: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const [inlineError, setInlineError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      inviteAccountMember(accountId, { email: email.trim(), role }),
    onSuccess: (res) => {
      if (res.status === 'pending') {
        if (res.email_sent) {
          toast.success(
            `Invite sent to ${res.email} — they'll see it when they sign up`,
          );
        } else {
          // Email delivery was skipped (e.g. Mailtrap not configured locally).
          // Surface the link so the admin can share it manually.
          toast.warning(
            `Invite created — email skipped. Share the link manually.`,
            {
              action: {
                label: 'Copy link',
                onClick: () => copyInviteLink(res.invite_url),
              },
              duration: 10_000,
            },
          );
        }
      } else {
        toast.success(`Added ${res.email}`);
      }
      onInvited();
      reset();
      onOpenChange(false);
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setInlineError('That user is already a member of this account.');
      } else {
        setInlineError(err.message || 'Failed to invite member');
      }
    },
  });

  function reset() {
    setEmail('');
    setRole('member');
    setInlineError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInlineError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setInlineError('Email is required');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setInlineError('Enter a valid email address');
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-lg font-semibold tracking-tight">{tHardcodedUi.raw('appAccountsIdPage.line1109JsxTextInviteMember')}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{tHardcodedUi.raw('appAccountsIdPage.line1112JsxTextInviteByEmailIfTheyDonAposT')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (inlineError) setInlineError(null);
                }}
                placeholder={tHardcodedUi.raw('appAccountsIdPage.line1130JsxAttrPlaceholderTeammateCompanyCom')}
                autoFocus
                className="pl-9"
                disabled={mutation.isPending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as AccountRole)}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{tHardcodedUi.raw('appAccountsIdPage.line1150JsxTextMemberCanUseAssignedProjects')}</SelectItem>
                <SelectItem value="admin">{tHardcodedUi.raw('appAccountsIdPage.line1153JsxTextAdminCanInviteMembers')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {inlineError && (
            <InfoBanner tone="destructive">{inlineError}</InfoBanner>
          )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="gap-1.5"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              Invite
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ============================== DANGER ZONE ==============================

function DangerZoneCard() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <SectionCard
      tone="destructive"
      title={tHardcodedUi.raw('appAccountsIdPage.line1198JsxAttrTitleDangerZone')}
      description={tHardcodedUi.raw('appAccountsIdPage.line1199JsxAttrDescriptionIrreversibleActionsForThisTeam')}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('appAccountsIdPage.line1203JsxTextDeleteAccount')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{tHardcodedUi.raw('appAccountsIdPage.line1205JsxTextPermanentlyDeleteThisAccountAndAllAssociatedProjects')}</p>
        </div>
        <Button
          variant="outline"
          disabled
          title={tHardcodedUi.raw('appAccountsIdPage.line1211JsxAttrTitleComingSoon')}
          className="shrink-0"
        >{tHardcodedUi.raw('appAccountsIdPage.line1214JsxTextComingSoon')}</Button>
      </div>
    </SectionCard>
  );
}

// ============================== PENDING INVITES ==============================

function PendingInvitesSection({
  accountId,
  canManage,
}: {
  accountId: string;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AccountInvitation | null>(
    null,
  );

  const invitesQuery = useQuery({
    queryKey: ['account-invites', accountId],
    queryFn: () => listAccountInvites(accountId),
    staleTime: 20_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['account-invites', accountId] });

  const resendMutation = useMutation({
    mutationFn: (inviteId: string) => resendAccountInvite(accountId, inviteId),
    onMutate: (id) => setPendingId(id),
    onSettled: () => setPendingId(null),
    onSuccess: (res) => {
      if (res.email_sent) {
        toast.success('Invite email sent');
      } else {
        // Mailtrap not configured (local dev or unconfigured prod). Hand the
        // admin the link directly so they can share it manually.
        toast.warning('Email skipped — copy invite link to share manually', {
          action: {
            label: 'Copy link',
            onClick: () => copyInviteLink(res.invite_url),
          },
          duration: 8_000,
        });
      }
      invalidate();
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to resend invite'),
  });

  const cancelMutation = useMutation({
    mutationFn: (inviteId: string) => cancelAccountInvite(accountId, inviteId),
    onMutate: (id) => setPendingId(id),
    onSettled: () => setPendingId(null),
    onSuccess: () => {
      toast.success('Invite cancelled');
      invalidate();
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to cancel invite'),
  });

  const invites = invitesQuery.data ?? [];
  if (!invites.length) return null;

  return (
    <div className="border-b border-border/60 bg-muted/20">
      <div className="px-6 pt-3 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">{tHardcodedUi.raw('appAccountsIdPage.line1287JsxTextPendingInvites')}{invites.length}
      </div>
      <List>
        {invites.map((invite) => {
          const busy = pendingId === invite.invite_id;
          return (
            <ListRow
              key={invite.invite_id}
              leading={<UserAvatar email={invite.email} size="md" />}
              title={invite.email}
              badges={
                <Badge variant="secondary" size="sm">
                  Pending
                </Badge>
              }
              subtitle={
                <InlineMeta>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Expires {formatDate(invite.expires_at)}
                  </span>
                </InlineMeta>
              }
              trailing={
                <>
                  <RoleBadge role={invite.initial_role} />
                  <div className="ml-1 w-7 shrink-0">
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            aria-label={`Actions for ${invite.email}`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem
                            onSelect={() =>
                              resendMutation.mutate(invite.invite_id)
                            }
                            className="gap-2"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line1336JsxTextResendInvite')}</DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => copyInviteLink(invite.invite_url)}
                            className="gap-2"
                          >
                            <LinkIcon className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line1343JsxTextCopyInvitationLink')}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => setCancelTarget(invite)}
                            className="gap-2"
                          >
                            <X className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdPage.line1351JsxTextCancelInvite')}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </>
              }
            />
          );
        })}
      </List>

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(o) => {
          if (!o) setCancelTarget(null);
        }}
        title={tHardcodedUi.raw('appAccountsIdPage.line1369JsxAttrTitleCancelInvite')}
        description={
          cancelTarget
            ? `Revoke the pending invite for ${cancelTarget.email}? They'll need a new invite to join.`
            : ''
        }
        confirmLabel={tHardcodedUi.raw('appAccountsIdPage.line1375JsxAttrConfirmlabelCancelInvite')}
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          if (!cancelTarget) return;
          cancelMutation.mutate(cancelTarget.invite_id);
          setCancelTarget(null);
        }}
      />
    </div>
  );
}
