'use client';

import Loading from '@/components/ui/loading';

import { MemberRow, type AccountMemberRole } from '@/components/account/member-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { ApiError } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

const ROLES: AccountMemberRole[] = ['owner', 'admin', 'member'];
type Role = AccountMemberRole;

/**
 * Members section — `accounts.members` to list, `accounts.invite` to add,
 * `accounts.updateMemberRole` to change a role, and `accounts.removeMember`
 * to remove. All mutations invalidate `['account-members', accountId]`.
 */
export function MembersSection({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const membersKey = ['account-members', accountId] as const;
  const members = useQuery({
    queryKey: membersKey,
    queryFn: () => kortix.accounts.members(accountId),
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: membersKey });
    qc.invalidateQueries({ queryKey: ['account-invites', accountId] });
    qc.invalidateQueries({ queryKey: ['account', accountId] });
  };

  const invite = useMutation({
    mutationFn: () => kortix.accounts.invite(accountId, { email: email.trim(), role }),
    onSuccess: (result) => {
      setEmail('');
      refresh();
      if (result.status === 'pending') toast.success(`Invitation sent to ${result.email}`);
      else toast.success(`${result.email} added`);
    },
    onError: (err: unknown) => {
      const conflict = err instanceof ApiError && err.status === 409;
      toast.error(conflict ? 'Already a member or invited' : 'Could not invite');
    },
  });

  const changeRole = useMutation({
    mutationFn: (vars: { userId: string; role: Role }) =>
      kortix.accounts.updateMemberRole(accountId, vars.userId, vars.role),
    onSuccess: () => {
      refresh();
      toast.success('Role updated');
    },
    onError: () => toast.error('Could not update the role'),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => kortix.accounts.removeMember(accountId, userId),
    onSuccess: () => {
      refresh();
      toast.success('Member removed');
    },
    onError: () => toast.error('Could not remove the member'),
  });

  const items = members.data ?? [];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Members</h3>

      {/* Invite — accounts.invite */}
      <Card className="p-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate();
          }}
        >
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            type="email"
            className="flex-1"
          />
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={!email.trim() || invite.isPending}>
            {invite.isPending && <Loading className="size-4" />}
            Invite
          </Button>
        </form>
      </Card>

      {/* List — accounts.members */}
      <Card className="divide-y divide-border p-0">
        {members.isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        )}
        {members.isError && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load members.
          </div>
        )}
        {members.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">Just you so far.</div>
        )}
        {items.map((m, i) => {
          const userId = m.user_id;
          const busy =
            (changeRole.isPending && changeRole.variables?.userId === userId) ||
            (remove.isPending && remove.variables === userId);
          return (
            <MemberRow
              key={userId ?? m.email ?? i}
              member={m}
              index={i}
              busy={busy}
              onChangeRole={(v: { userId: string; role: Role }) => changeRole.mutate(v)}
              onRemove={(id: string) => remove.mutate(id)}
            />
          );
        })}
      </Card>
    </section>
  );
}
