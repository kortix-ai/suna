'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clock,
  KeyRound,
  Link as LinkIcon,
  Loader2,
  Mail,
  MoreHorizontal,
  RefreshCw,
  Shield,
  Trash2,
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupsTab } from '@/components/iam/groups-tab';
import {
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type AccountRole,
  cancelAccountInvite,
  getAccount,
  inviteAccountMember,
  leaveAccount,
  listAccountInvites,
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
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitial(text: string) {
  return (text.trim().charAt(0) || '?').toUpperCase();
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
    toast.message('Copy this invite link', { description: url, duration: 15_000 });
  }
}

export default function AccountSettingsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
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

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const members = membersQuery.data ?? [];
  const isOwner = account?.role === 'owner';
  const isAdmin = account?.role === 'admin';
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
                {accountQuery.isLoading ? <Skeleton className="h-7 w-48" /> : account?.name}
              </h1>
              {account && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {account.personal_account
                    ? 'Your personal account. Invite collaborators to share projects.'
                    : 'Manage account settings, members, and access.'}
                </p>
              )}
            </div>
          </div>

          {accountQuery.isError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
              <p className="text-sm font-medium text-destructive">Failed to load account</p>
              <p className="mt-1 text-xs text-destructive/80">
                {(accountQuery.error as Error).message}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => accountQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          )}

          {accountQuery.isLoading && (
            <>
              <Skeleton className="h-48 w-full rounded-xl" />
              <Skeleton className="h-64 w-full rounded-xl" />
            </>
          )}

          {account && (
            <Tabs defaultValue="members" className="space-y-6">
              <TabsList>
                <TabsTrigger value="members">All members</TabsTrigger>
                <TabsTrigger value="groups">Groups</TabsTrigger>
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
                  isOwner={isOwner}
                  isAdmin={isAdmin}
                />
              </TabsContent>

              <TabsContent value="groups" className="space-y-6">
                <GroupsTab accountId={account.account_id} canManage={isOwner || isAdmin} />
              </TabsContent>

              <TabsContent value="settings" className="space-y-6">
                <GeneralCard
                  account={account}
                  queryClient={queryClient}
                  isOwner={isOwner}
                />
                {isTeam && isOwner && <DangerZoneCard />}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </main>
    </div>
  );
}

// ============================== GENERAL ==============================

function GeneralCard({
  account,
  queryClient,
  isOwner,
}: {
  account: AccountDetail;
  queryClient: ReturnType<typeof useQueryClient>;
  isOwner: boolean;
}) {
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
    onError: (err: Error) => toast.error(err.message || 'Failed to update account'),
  });

  const trimmed = name.trim();
  const canSubmit = isOwner && trimmed.length > 0 && trimmed !== account.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    renameMutation.mutate(trimmed);
  }

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <h2 className="text-base font-semibold text-foreground">General</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Basic information about this account.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="account-name">Account name</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isOwner || renameMutation.isPending}
            maxLength={120}
            className="max-w-md"
            title={isOwner ? undefined : 'Only owners can rename'}
          />
          {!isOwner && (
            <p className="text-xs text-muted-foreground">Only owners can rename this account.</p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 pt-4">
          <p className="text-xs text-muted-foreground">
            Created {formatDate(account.created_at)}
          </p>
          <Button type="submit" disabled={!canSubmit || renameMutation.isPending} className="gap-1.5">
            {renameMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </section>
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
  isOwner,
  isAdmin,
}: {
  account: AccountDetail;
  members: AccountMember[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
  currentUserId: string;
  isOwner: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AccountMember | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const canInvite = isOwner || isAdmin;
  const canManage = isOwner;

  const sorted = useMemo(() => {
    const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };
    return [...members].sort((a, b) => {
      const r = rank[a.account_role] - rank[b.account_role];
      if (r !== 0) return r;
      return memberLabel(a).localeCompare(memberLabel(b));
    });
  }, [members]);

  const invalidateMembers = () => {
    queryClient.invalidateQueries({ queryKey: ['account-members', account.account_id] });
    queryClient.invalidateQueries({ queryKey: ['account-invites', account.account_id] });
    queryClient.invalidateQueries({ queryKey: ['account', account.account_id] });
  };

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeAccountMember(account.account_id, userId),
    onMutate: (userId) => setPendingUserId(userId),
    onSettled: () => setPendingUserId(null),
    onSuccess: () => {
      toast.success('Member removed');
      invalidateMembers();
      setRemoveTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove member'),
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
    onError: (err: Error) => toast.error(err.message || 'Failed to update role'),
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
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Members{' '}
            <span className="font-normal text-muted-foreground">({account.member_count})</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            People with access to this account.
          </p>
        </div>
        {canInvite && (
          <Button onClick={() => setInviteOpen(true)} size="sm" className="gap-1.5">
            <UserPlus className="h-4 w-4" />
            Invite member
          </Button>
        )}
      </header>

      {isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">{error?.message || 'Failed to load members'}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-6 py-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && !isError && (
        <PendingInvitesSection accountId={account.account_id} canManage={canInvite} />
      )}

      {!isLoading && !isError && (
        <ul className="divide-y divide-border/60">
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
              <li
                key={member.user_id}
                className="flex items-center gap-3 px-6 py-3"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-sm font-semibold text-foreground">
                  {getInitial(memberLabel(member))}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {memberLabel(member)}
                    </span>
                    {isSelf && (
                      <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                        You
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Joined {formatDate(member.joined_at)}</span>
                    {member.account_role === 'member' && typeof member.explicit_project_count === 'number' && (
                      <>
                        <span className="text-muted-foreground/40">/</span>
                        <span>{member.explicit_project_count} project{member.explicit_project_count === 1 ? '' : 's'}</span>
                      </>
                    )}
                  </div>
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
                          <KeyRound className="h-3.5 w-3.5" />
                          View &amp; Edit permission policies
                        </DropdownMenuItem>
                        {canManage && !isSelf && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              Change role
                            </DropdownMenuLabel>
                            {(['owner', 'admin', 'member'] as AccountRole[]).map((role) => (
                              <DropdownMenuItem
                                key={role}
                                disabled={role === member.account_role}
                                onSelect={() =>
                                  roleMutation.mutate({ userId: member.user_id, role })
                                }
                                className="gap-2"
                              >
                                <Shield className="h-3.5 w-3.5" />
                                {ROLE_LABEL[role]}
                                {role === member.account_role && (
                                  <span className="ml-auto text-[10px] text-muted-foreground">
                                    Current
                                  </span>
                                )}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => setRemoveTarget(member)}
                              disabled={isLastOwner}
                              className="gap-2 text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Remove from team
                            </DropdownMenuItem>
                          </>
                        )}
                        {isSelf && !account.personal_account && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => setLeaveConfirmOpen(true)}
                              disabled={isLastOwner}
                              className="gap-2 text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Leave team
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </li>
            );
          })}
          {sorted.length === 0 && (
            <li className="px-6 py-8 text-center text-sm text-muted-foreground">
              No members yet.
            </li>
          )}
        </ul>
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
        title="Remove member"
        description={
          <span>
            Remove <span className="font-medium text-foreground">{removeTarget ? memberLabel(removeTarget) : ''}</span> from{' '}
            <span className="font-medium text-foreground">{account.name}</span>? They will lose
            access immediately.
          </span>
        }
        confirmLabel="Remove"
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget.user_id)}
        isPending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title="Leave team"
        description={
          <span>
            You&apos;ll lose access to <span className="font-medium text-foreground">{account.name}</span>{' '}
            and its projects.
          </span>
        }
        confirmLabel="Leave"
        onConfirm={() => leaveMutation.mutate()}
        isPending={leaveMutation.isPending}
      />
    </section>
  );
}

function RoleBadge({ role }: { role: AccountRole }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 rounded-md px-1.5 text-[10px] font-medium',
        role === 'owner' && 'border-foreground/30 text-foreground',
      )}
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
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const [inlineError, setInlineError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => inviteAccountMember(accountId, { email: email.trim(), role }),
    onSuccess: (res) => {
      if (res.status === 'pending') {
        if (res.email_sent) {
          toast.success(`Invite sent to ${res.email} — they'll see it when they sign up`);
        } else {
          // Email delivery was skipped (e.g. Mailtrap not configured locally).
          // Surface the link so the admin can share it manually.
          toast.warning(`Invite created — email skipped. Share the link manually.`, {
            action: {
              label: 'Copy link',
              onClick: () => copyInviteLink(res.invite_url),
            },
            duration: 10_000,
          });
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
          <DialogTitle className="text-lg font-semibold tracking-tight">Invite member</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Invite by email. If they don&apos;t have a Kortix account yet, they&apos;ll get access when they sign up.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
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
                placeholder="teammate@company.com"
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
                <SelectItem value="member">Member — can use assigned projects</SelectItem>
                <SelectItem value="admin">Admin — can invite members</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {inlineError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {inlineError}
            </div>
          )}

          <div className="-mx-6 mt-4 flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" className="gap-1.5" disabled={mutation.isPending}>
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
  return (
    <section className="rounded-xl border border-destructive/30 bg-destructive/5">
      <header className="border-b border-destructive/20 px-6 py-4">
        <h2 className="text-base font-semibold text-destructive">Danger zone</h2>
        <p className="mt-0.5 text-xs text-destructive/80">
          Irreversible actions for this team.
        </p>
      </header>
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Delete account</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Permanently delete this account and all associated projects.
          </p>
        </div>
        <Button variant="outline" disabled title="Coming soon" className="shrink-0">
          Coming soon
        </Button>
      </div>
    </section>
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
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AccountInvitation | null>(null);

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
    onError: (err: Error) => toast.error(err.message || 'Failed to resend invite'),
  });

  const cancelMutation = useMutation({
    mutationFn: (inviteId: string) => cancelAccountInvite(accountId, inviteId),
    onMutate: (id) => setPendingId(id),
    onSettled: () => setPendingId(null),
    onSuccess: () => {
      toast.success('Invite cancelled');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to cancel invite'),
  });

  const invites = invitesQuery.data ?? [];
  if (!invites.length) return null;

  return (
    <div className="border-b border-border/60 bg-muted/20">
      <div className="px-6 pt-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Pending invites · {invites.length}
      </div>
      <ul className="divide-y divide-border/60">
        {invites.map((invite) => {
          const busy = pendingId === invite.invite_id;
          return (
            <li key={invite.invite_id} className="flex items-center gap-3 px-6 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-background text-muted-foreground">
                <Mail className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-foreground">{invite.email}</span>
                  <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                    Pending
                  </Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>Expires {formatDate(invite.expires_at)}</span>
                </div>
              </div>
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
                        onSelect={() => resendMutation.mutate(invite.invite_id)}
                        className="gap-2"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Resend invite
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => copyInviteLink(invite.invite_url)}
                        className="gap-2"
                      >
                        <LinkIcon className="h-3.5 w-3.5" />
                        Copy invitation link
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => setCancelTarget(invite)}
                        className="gap-2 text-destructive focus:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel invite
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(o) => { if (!o) setCancelTarget(null); }}
        title="Cancel invite"
        description={
          cancelTarget
            ? `Revoke the pending invite for ${cancelTarget.email}? They'll need a new invite to join.`
            : ''
        }
        confirmLabel="Cancel invite"
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
