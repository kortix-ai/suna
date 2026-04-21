'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, Mail, Trash2 } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InstanceMembersPanel({ sandboxId }: { sandboxId: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
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
      if (data.status === 'added') {
        sonnerToast.success(`${variables.email} now has access`);
      } else {
        sonnerToast.success(`Invite sent to ${variables.email}`);
      }
      setEmail('');
      setInviteRole('member');
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'members', sandboxId] });
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

  const canManage = membersQuery.data?.can_manage ?? false;
  const viewerUserId = membersQuery.data?.viewer_user_id ?? '';
  const members = membersQuery.data?.members ?? [];
  const pending = membersQuery.data?.pending_invites ?? [];
  const emailValid = EMAIL_RE.test(email.trim());

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Members</h2>
        <p className="text-sm text-muted-foreground">
          Invite people by email. If they already have a Kortix account they get instant access;
          if not, we send a signup link and add them automatically when they join.
        </p>
      </div>

      {canManage ? (
        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (emailValid) {
              addMutation.mutate({ email: email.trim(), role: inviteRole });
            }
          }}
        >
          <Input
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={addMutation.isPending}
          />
          <Select
            value={inviteRole}
            onValueChange={(v) => setInviteRole(v as 'admin' | 'member')}
            disabled={addMutation.isPending}
          >
            <SelectTrigger className="w-[120px] shrink-0 capitalize">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={!emailValid || addMutation.isPending}>
            {addMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              'Invite'
            )}
          </Button>
        </form>
      ) : null}

      {membersQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading members…
        </div>
      ) : membersQuery.error ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          {membersQuery.error instanceof Error
            ? membersQuery.error.message
            : 'Failed to load members.'}
        </div>
      ) : (
        <div className="space-y-5">
          <section className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Active ({members.length})
            </div>
            {members.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 p-6 text-center text-sm text-muted-foreground">
                No members yet.
              </div>
            ) : (
              <div className="space-y-2">
                {members.map((member) => {
                  const isSelf = member.user_id === viewerUserId;
                  const isOwner = member.role === 'owner';
                  // Only plain members can be removed from a sandbox — removing an
                  // admin's sandbox_members row is a no-op because admins have
                  // implicit access through their account role. They'd have to be
                  // demoted first, which is a different (future) flow.
                  const showRemove = canManage && member.role === 'member' && !isSelf;
                  const roleEditable = canManage && !isOwner && !isSelf;
                  const roleChanging =
                    roleMutation.isPending && roleMutation.variables?.userId === member.user_id;
                  return (
                    <div
                      key={member.user_id}
                      className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/10 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1 flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {member.email || member.user_id}
                        </span>
                        {isSelf ? (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground">
                            You
                          </span>
                        ) : null}
                      </div>
                      {roleEditable ? (
                        <RolePicker
                          role={member.role}
                          onSelect={(role) =>
                            roleMutation.mutate({ userId: member.user_id, role })
                          }
                          pending={roleChanging}
                        />
                      ) : (
                        <RoleBadge role={member.role} />
                      )}
                      {showRemove ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRemoveTarget(member)}
                          disabled={removeMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {pending.length > 0 ? (
            <section className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Invites ({pending.length})
              </div>
              <div className="space-y-2">
                {pending.map((invite) => (
                  <div
                    key={invite.invite_id}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/10 px-4 py-3"
                  >
                    <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{invite.email}</div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Invited {new Date(invite.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <RoleBadge role={invite.role} />
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setRevokeTarget(invite)}
                        disabled={revokeMutation.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title="Remove member?"
        description={
          removeTarget
            ? `${removeTarget.email || removeTarget.user_id} will lose access to this instance.`
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
            ? `${revokeTarget.email} will no longer be able to join this instance via the pending invite.`
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.invite_id)}
        isPending={revokeMutation.isPending}
      />
    </div>
  );
}

function roleToneClasses(role: SandboxMemberRole | null): string {
  switch (role) {
    case 'owner':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    case 'admin':
      return 'border-blue-500/40 bg-blue-500/10 text-blue-300';
    default:
      return 'border-border/60 bg-muted/30 text-muted-foreground';
  }
}

function roleLabel(role: SandboxMemberRole | null): string {
  if (!role) return '—';
  return role[0].toUpperCase() + role.slice(1);
}

function RoleBadge({ role }: { role: SandboxMemberRole | null }) {
  if (!role) return null;
  return (
    <span
      className={cn(
        'shrink-0 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border',
        roleToneClasses(role),
      )}
    >
      {roleLabel(role)}
    </span>
  );
}

// Editable role control. V1 only toggles between admin and member; owner role
// is never shown here because the owner row renders the plain badge instead.
const ASSIGNABLE_ROLES: SandboxMemberRole[] = ['admin', 'member'];

function RolePicker({
  role,
  onSelect,
  pending,
}: {
  role: SandboxMemberRole | null;
  onSelect: (next: SandboxMemberRole) => void;
  pending: boolean;
}) {
  const value: SandboxMemberRole = role === 'admin' ? 'admin' : 'member';
  return (
    <Select
      value={value}
      disabled={pending}
      onValueChange={(next) => {
        if (next !== value) onSelect(next as SandboxMemberRole);
      }}
    >
      <SelectTrigger
        className={cn(
          'h-6 shrink-0 rounded-full border px-2.5 text-[10px] uppercase tracking-wide',
          'focus:ring-0 focus:ring-offset-0',
          roleToneClasses(role),
        )}
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <SelectValue placeholder={roleLabel(role)} />
        )}
      </SelectTrigger>
      <SelectContent align="end">
        {ASSIGNABLE_ROLES.map((candidate) => (
          <SelectItem key={candidate} value={candidate} className="capitalize">
            {candidate}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
