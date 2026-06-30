'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreHorizontal, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

const ROLES = ['owner', 'admin', 'member'] as const;
type Role = (typeof ROLES)[number];

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
      const r = result as any;
      if (r?.status === 'pending') toast.success(`Invitation sent to ${r.email}`);
      else toast.success(`${r?.email ?? 'Member'} added`);
    },
    onError: (err: any) => {
      const msg = String(err?.message ?? '');
      toast.error(msg.includes('409') ? 'Already a member or invited' : 'Could not invite');
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

  const items = (members.data as any[]) ?? [];

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
            {invite.isPending && <Loader2 className="size-4 animate-spin" />}
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
          const label = (m.email ?? m.user_id ?? 'Member') as string;
          const initial = label.charAt(0).toUpperCase();
          const memberRole = (m.account_role ?? 'member') as string;
          const userId = m.user_id as string | undefined;
          const busy =
            (changeRole.isPending && changeRole.variables?.userId === userId) ||
            (remove.isPending && remove.variables === userId);
          return (
            <div key={userId ?? m.email ?? i} className="flex items-center gap-3 px-4 py-3">
              <Avatar size="sm">
                <AvatarFallback>{initial}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {m.joined_at ? `Joined ${relativeTime(m.joined_at)}` : (userId ?? '')}
                </div>
              </div>
              <Badge variant="outline" className="capitalize">
                {memberRole}
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={!userId || busy}
                    aria-label={`Manage ${label}`}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <MoreHorizontal className="size-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel>Change role</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={memberRole}
                    onValueChange={(v) => {
                      if (userId && v !== memberRole)
                        changeRole.mutate({ userId, role: v as Role });
                    }}
                  >
                    {ROLES.map((r) => (
                      <DropdownMenuRadioItem key={r} value={r} className="capitalize">
                        {r}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => userId && remove.mutate(userId)}
                  >
                    <UserMinus className="size-4" /> Remove from account
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </Card>
    </section>
  );
}
