'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

import {
  addSandboxMember,
  listSandboxMembers,
  removeSandboxMember,
  revokeSandboxInvite,
  updateSandboxMemberRole,
  type SandboxMember,
  type SandboxMemberRole,
  type SandboxPendingInvite,
} from '@/lib/platform-client';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserRow } from '@/components/ui/user-row';
import { useCan } from '@/hooks/platform/use-can';
import {
  IconCheck,
  IconDelete,
  IconInvite,
  IconLoader,
  IconMore,
  IconUsers,
} from '@/components/ui/kortix-icons';
import { User } from 'lucide-react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InstanceMembersPanel({ sandboxId }: { sandboxId: string }) {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SandboxMember | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SandboxPendingInvite | null>(null);

  const membersQuery = useQuery({
    queryKey: ['sandbox', 'members', sandboxId],
    queryFn: () => listSandboxMembers(sandboxId),
  });

  const addMutation = useMutation({
    mutationFn: (input: { email: string; role: 'admin' | 'member' }) =>
      addSandboxMember(sandboxId, input.email, input.role),
    onSuccess: (data, variables) => {
      sonnerToast.success(
        data.status === 'added'
          ? `${variables.email} now has access`
          : `Invite sent to ${variables.email}`,
      );
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'members', sandboxId] });
      setInviteOpen(false);
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to add member');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeSandboxMember(sandboxId, userId),
    onSuccess: () => {
      sonnerToast.success('Member removed');
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'members', sandboxId] });
      setRemoveTarget(null);
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to remove member');
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokeSandboxInvite(sandboxId, inviteId),
    onSuccess: () => {
      sonnerToast.success('Invite revoked');
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'members', sandboxId] });
      setRevokeTarget(null);
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to revoke invite');
    },
  });

  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: SandboxMemberRole }) =>
      updateSandboxMemberRole(sandboxId, input.userId, input.role),
    onSuccess: (_data, variables) => {
      sonnerToast.success(`Role updated to ${variables.role}`);
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'members', sandboxId] });
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to change role');
    },
  });

  const canInvite = useCan(sandboxId, 'members:invite').allowed;
  const canRemove = useCan(sandboxId, 'members:remove').allowed;
  const canChangeRole = useCan(sandboxId, 'members:change_role').allowed;
  const viewerUserId = membersQuery.data?.viewer_user_id ?? '';
  const members = membersQuery.data?.members ?? [];
  const pending = membersQuery.data?.pending_invites ?? [];

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Team</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            People with access to this instance. Invite teammates by email —
            they get instant access if they already use Kortix, otherwise we
            send them a signup link.
          </p>
        </div>
        {canInvite ? (
          <Button
            size="sm"
            onClick={() => setInviteOpen(true)}
            className="shrink-0"
          >
            <IconInvite className="h-3.5 w-3.5" />
            Invite teammate
          </Button>
        ) : null}
      </header>

      {membersQuery.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <IconLoader className="h-4 w-4 animate-spin" /> Loading team…
        </div>
      ) : membersQuery.error ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          {membersQuery.error instanceof Error
            ? membersQuery.error.message
            : 'Failed to load members.'}
        </div>
      ) : members.length === 0 && pending.length === 0 ? (
        <EmptyState
          icon={IconUsers}
          title="Just you, for now"
          description="Invite a teammate to collaborate on this instance. They'll see projects you grant them access to, and their sessions stay private from yours."
          action={
            canInvite ? (
              <Button onClick={() => setInviteOpen(true)}>
                <IconInvite className="mr-1.5 h-3.5 w-3.5" />
                Invite teammate
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-8">
          {members.length > 0 ? (
            <MemberSection
              label={`Members · ${members.length}`}
              members={members}
              viewerUserId={viewerUserId}
              canChangeRole={canChangeRole}
              canRemove={canRemove}
              roleMutation={roleMutation}
              onRemove={(m) => setRemoveTarget(m)}
            />
          ) : null}

          {pending.length > 0 ? (
            <PendingSection
              invites={pending}
              canRevoke={canInvite}
              onRevoke={(i) => setRevokeTarget(i)}
            />
          ) : null}
        </div>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onSubmit={(input) => addMutation.mutate(input)}
        pending={addMutation.isPending}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title="Remove from team?"
        description={
          removeTarget
            ? removeTarget.role === 'admin'
              ? `${removeTarget.email || removeTarget.user_id} is an admin on your account. Removing them revokes their access to every instance under this account, not just this one.`
              : `${removeTarget.email || removeTarget.user_id} will lose access to this instance and any projects they were added to.`
            : ''
        }
        confirmLabel="Remove"
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget.user_id)}
        isPending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke invite?"
        description={
          revokeTarget
            ? `${revokeTarget.email} won't be able to join with the pending invite link.`
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.invite_id)}
        isPending={revokeMutation.isPending}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Section heads + sub-components
// ──────────────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground/60 text-[11px] font-semibold uppercase tracking-[0.08em]">
      {children}
    </div>
  );
}

function MemberSection({
  label,
  members,
  viewerUserId,
  canChangeRole,
  canRemove,
  roleMutation,
  onRemove,
}: {
  label: string;
  members: SandboxMember[];
  viewerUserId: string;
  canChangeRole: boolean;
  canRemove: boolean;
  roleMutation: {
    mutate: (input: { userId: string; role: SandboxMemberRole }) => void;
    isPending: boolean;
    variables?: { userId: string; role: SandboxMemberRole };
  };
  onRemove: (m: SandboxMember) => void;
}) {
  return (
    <section className="space-y-3">
      <SectionLabel>{label}</SectionLabel>
      <div className="space-y-1.5">
        {members.map((member) => {
          const isSelf = member.user_id === viewerUserId;
          const isOwner = member.role === 'owner';
          const roleEditable = canChangeRole && !isOwner && !isSelf;
          const removable = canRemove && member.role !== 'owner' && !isSelf;
          const showActions = roleEditable || removable;
          const pendingRole =
            roleMutation.isPending && roleMutation.variables?.userId === member.user_id;
          return (
            <UserRow
              key={member.user_id}
              email={member.email || member.user_id}
              isSelf={isSelf}
              trailing={
                <>
                  <RoleTag role={member.role} />
                  {showActions ? (
                    <MemberRowActions
                      role={member.role}
                      roleEditable={roleEditable}
                      removable={removable}
                      pending={pendingRole}
                      onChangeRole={(next) =>
                        roleMutation.mutate({
                          userId: member.user_id,
                          role: next,
                        })
                      }
                      onRemove={() => onRemove(member)}
                    />
                  ) : null}
                </>
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function PendingSection({
  invites,
  canRevoke,
  onRevoke,
}: {
  invites: SandboxPendingInvite[];
  canRevoke: boolean;
  onRevoke: (i: SandboxPendingInvite) => void;
}) {
  return (
    <section className="space-y-3">
      <SectionLabel>Pending · {invites.length}</SectionLabel>
      <div className="space-y-1.5">
        {invites.map((invite) => (
          <UserRow
            key={invite.invite_id}
            email={invite.email}
            subtitle={
              <span>
                Invited {formatRelative(invite.created_at)} · expires{' '}
                {formatRelative(invite.expires_at)}
              </span>
            }
            trailing={
              <div className="flex items-center gap-1">
                <RoleTag role={invite.role} />
                {canRevoke ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive h-7 w-7"
                    onClick={() => onRevoke(invite)}
                    aria-label="Revoke invite"
                  >
                    <IconDelete className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            }
          />
        ))}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Role chip + popover
// ──────────────────────────────────────────────────────────────────────────────

function roleBadgeVariant(
  role: SandboxMemberRole | null | 'admin' | 'member',
): 'warning' | 'info' | 'muted' {
  switch (role) {
    case 'owner':
      return 'warning';
    case 'admin':
      return 'info';
    default:
      return 'muted';
  }
}

function roleLabel(role: SandboxMemberRole | null | 'admin' | 'member'): string {
  if (!role) return '—';
  return role[0].toUpperCase() + role.slice(1);
}

function RoleTag({ role }: { role: SandboxMemberRole | null | 'admin' | 'member' }) {
  if (!role) return null;
  return (
    <Badge variant={roleBadgeVariant(role)} size="sm" className="uppercase tracking-wide">
      {roleLabel(role)}
    </Badge>
  );
}

function MemberRowActions({
  role,
  roleEditable,
  removable,
  pending,
  onChangeRole,
  onRemove,
}: {
  role: SandboxMemberRole | null;
  roleEditable: boolean;
  removable: boolean;
  pending: boolean;
  onChangeRole: (next: SandboxMemberRole) => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          disabled={pending}
          aria-label="Member actions"
          className="text-muted-foreground hover:text-foreground h-7 w-7"
        >
          {pending ? (
            <IconLoader className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconMore className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {roleEditable ? (
          <>
            <RoleMenuItem
              selected={role === 'admin'}
              title="Admin"
              onSelect={() => onChangeRole('admin')}
            />
            <RoleMenuItem
              selected={role === 'member'}
              title="Member"
              onSelect={() => onChangeRole('member')}
            />
          </>
        ) : null}
        {removable ? (
          <>
            {roleEditable ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onSelect={onRemove}
              className="focus:text-destructive focus:bg-destructive/10"
            >
              <IconDelete className="h-3.5 w-3.5" />
              Remove
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RoleMenuItem({
  selected,
  title,
  subtitle,
  onSelect,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="flex items-start gap-2 py-2"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-foreground text-xs font-medium">
          <User className="h-3.5 w-3.5" />
          {title}
        </div>
        {subtitle ? (
          <div className="text-muted-foreground text-[11px] leading-snug">
            {subtitle}
          </div>
        ) : null}
      </div>
      <IconCheck
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          selected ? 'text-foreground' : 'text-transparent',
        )}
      />
    </DropdownMenuItem>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Invite dialog
// ──────────────────────────────────────────────────────────────────────────────

function InviteDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { email: string; role: 'admin' | 'member' }) => void;
  pending: boolean;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');

  const trimmed = email.trim();
  const emailValid = EMAIL_RE.test(trimmed);
  const displayName =
    emailValid && trimmed.includes('@') ? trimmed.split('@')[0] : '';

  // Reset state when closing
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setEmail('');
      setRole('member');
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        {/* Hero — centered avatar that animates between empty and filled states */}
        <div className="relative flex flex-col items-center gap-3 px-6 pt-8 pb-6">
          <div className="relative">
            {emailValid ? (
              <UserAvatar
                email={trimmed}
                size="xl"
                className="ring-background shadow-sm ring-4"
              />
            ) : (
              <div className="bg-muted/40 border-border/60 text-muted-foreground/40 flex size-14 items-center justify-center rounded-full border border-dashed">
                <IconInvite className="h-5 w-5" strokeWidth={1.5} />
              </div>
            )}
          </div>
          <div className="text-center">
            <DialogTitle className="text-[17px] font-semibold tracking-tight">
              {emailValid ? `Invite ${displayName}` : 'Invite teammate'}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px]">
              {emailValid
                ? "They'll get an email with a link to join."
                : 'Add someone to collaborate on this instance.'}
            </DialogDescription>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (emailValid && !pending) {
              onSubmit({ email: trimmed, role });
            }
          }}
        >
          <div className="space-y-5 px-6 pt-2 pb-6">
            <div className="space-y-1.5">
              <Label
                htmlFor="invite-email"
                className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.08em]"
              >
                Email address
              </Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
                autoFocus
                className="h-11 text-[14px]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.08em]">
                Role
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <RoleCard
                  selected={role === 'member'}
                  onSelect={() => setRole('member')}
                  title="Member"
                  disabled={pending}
                />
                <RoleCard
                  selected={role === 'admin'}
                  onSelect={() => setRole('admin')}
                  title="Admin"
                  disabled={pending}
                />
              </div>
            </div>
          </div>

          <div className="border-border/60 bg-muted/20 flex items-center justify-between gap-2 border-t px-6 py-3.5">
            <p className="text-muted-foreground/70 text-[11px]">
              If they don't have Kortix yet, we'll send a signup link.
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!emailValid || pending}
              >
                {pending ? (
                  <IconLoader className="h-4 w-4 animate-spin" />
                ) : (
                  'Send invite'
                )}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleCard({
  selected,
  onSelect,
  title,
  description,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'group relative flex h-full flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'bg-foreground/10 shadow-sm'
          : 'border-border/60 bg-muted/20 hover:border-border hover:bg-muted/40',
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-foreground text-[13px] font-semibold">
          {title}
        </span>
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border transition-colors',
            selected
              ? 'border-foreground bg-foreground'
              : 'border-border group-hover:border-muted-foreground/60',
          )}
        >
          {selected ? (
            <IconCheck
              className="text-background h-3 w-3"
              strokeWidth={3}
            />
          ) : null}
        </span>
      </div>
      {description ? (
        <p className="text-muted-foreground text-[11px] leading-snug">
          {description}
        </p>
      ) : null}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - Date.now();
  const absDiff = Math.abs(diff);
  const future = diff > 0;
  if (absDiff < 60_000) return future ? 'in a moment' : 'just now';
  if (absDiff < 3_600_000) {
    const m = Math.floor(absDiff / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (absDiff < 86_400_000) {
    const h = Math.floor(absDiff / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.floor(absDiff / 86_400_000);
  if (d < 30) return future ? `in ${d}d` : `${d}d ago`;
  return new Date(value).toLocaleDateString();
}
