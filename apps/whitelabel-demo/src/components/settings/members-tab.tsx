'use client';

import Loading from '@/components/ui/loading';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { relativeTime } from '@/lib/utils';
import type {
  PendingProjectInvite,
  ProjectAccessMember,
  ProjectAccessRequest,
  ProjectGroupGrant,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Mail, Send, Trash2, Users, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type Role = 'manager' | 'member';
const ROLES: Role[] = ['manager', 'member'];

/**
 * One access mutation: run it, invalidate the query keys that show its result,
 * then say what happened. The seven actions below differ only in their call,
 * their keys, and their copy.
 */
function useAccessAction<TVars>(
  projectId: string,
  options: {
    run: (vars: TVars) => Promise<unknown>;
    keys: readonly unknown[];
    done: string;
    failed: string;
    onDone?: () => void;
  },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: options.run,
    onSuccess: () => {
      options.onDone?.();
      qc.invalidateQueries({ queryKey: options.keys });
      toast.success(options.done);
    },
    onError: () => toast.error(options.failed),
  });
}

export function MembersTab({ projectId }: { projectId: string }) {
  const accessKey = qk.access(projectId);
  const requestsKey = [...accessKey, 'requests'] as const;
  const pendingKey = [...accessKey, 'pending'] as const;
  const grantsKey = [...accessKey, 'grants'] as const;

  const access = useQuery({
    queryKey: accessKey,
    queryFn: () => kortix.project(projectId).access.list(),
  });
  const requests = useQuery({
    queryKey: requestsKey,
    queryFn: () => kortix.project(projectId).access.requests(),
  });
  const pending = useQuery({
    queryKey: pendingKey,
    queryFn: () => kortix.project(projectId).access.pendingInvites(),
  });
  const grants = useQuery({
    queryKey: grantsKey,
    queryFn: () => kortix.project(projectId).access.groupGrants(),
  });

  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');

  const invite = useAccessAction<void>(projectId, {
    run: () => kortix.project(projectId).access.invite(email.trim(), inviteRole),
    keys: [accessKey, pendingKey],
    done: 'Invitation sent',
    failed: 'Could not invite',
    onDone: () => setEmail(''),
  });

  const updateRole = useAccessAction<{ userId: string; role: Role }>(projectId, {
    run: (v) => kortix.project(projectId).access.update(v.userId, v.role),
    keys: accessKey,
    done: 'Role updated',
    failed: 'Could not update role',
  });

  const revoke = useAccessAction<string>(projectId, {
    run: (userId) => kortix.project(projectId).access.revoke(userId),
    keys: accessKey,
    done: 'Access revoked',
    failed: 'Could not revoke',
  });

  const approve = useAccessAction<string>(projectId, {
    run: (requestId) => kortix.project(projectId).access.approveRequest(requestId, 'member'),
    keys: [requestsKey, accessKey],
    done: 'Request approved',
    failed: 'Could not approve',
  });

  const reject = useAccessAction<string>(projectId, {
    run: (requestId) => kortix.project(projectId).access.rejectRequest(requestId),
    keys: requestsKey,
    done: 'Request rejected',
    failed: 'Could not reject',
  });

  const resendInvite = useAccessAction<string>(projectId, {
    run: (inviteId) => kortix.project(projectId).access.resendInvite(inviteId),
    keys: pendingKey,
    done: 'Invite resent',
    failed: 'Could not resend',
  });

  const revokeInvite = useAccessAction<string>(projectId, {
    run: (inviteId) => kortix.project(projectId).access.revokeInvite(inviteId),
    keys: pendingKey,
    done: 'Invite revoked',
    failed: 'Could not revoke invite',
  });

  const members: ProjectAccessMember[] = access.data?.members ?? [];
  const requestItems: ProjectAccessRequest[] = (requests.data?.requests ?? []).filter(
    (r) => r.status === 'pending',
  );
  const pendingItems: PendingProjectInvite[] = pending.data?.pending ?? [];
  const grantItems: ProjectGroupGrant[] = grants.data?.grants ?? [];

  return (
    <div className="space-y-4">
      {/* Invite */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Mail className="size-4 text-muted-foreground" /> Invite a member
        </div>
        <form
          className="mt-3 flex flex-wrap gap-2"
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
            className="min-w-[12rem] flex-1"
          />
          <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
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

      {/* Members */}
      <Card className="p-0">
        <div className="flex items-center gap-2 px-5 pt-5 text-sm font-medium">
          <Users className="size-4 text-muted-foreground" /> Members
        </div>
        <div className="mt-2 divide-y divide-border">
          {access.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-48" />
            </div>
          )}
          {access.isSuccess && members.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">Just you so far.</div>
          )}
          {members.map((m, i) => {
            const userId = String(m.user_id ?? m.email ?? i);
            const role: Role = (m.effective_project_role ?? m.project_role ?? 'member') as Role;
            const implicit = Boolean(m.has_implicit_access);
            return (
              <div key={userId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm">{m.email ?? m.user_id ?? 'Member'}</div>
                  {m.effective_source && (
                    <div className="text-xs text-muted-foreground">via {m.effective_source}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {implicit ? (
                    <Badge variant="secondary" className="capitalize">
                      {role}
                    </Badge>
                  ) : (
                    <Select
                      value={role}
                      onValueChange={(v) => updateRole.mutate({ userId, role: v as Role })}
                    >
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!implicit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(userId)}
                      aria-label="Revoke access"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Pending invites */}
      <Card className="p-0">
        <div className="flex items-center gap-2 px-5 pt-5 text-sm font-medium">
          <Send className="size-4 text-muted-foreground" /> Pending invites
        </div>
        <div className="mt-2 divide-y divide-border">
          {pending.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-40" />
            </div>
          )}
          {pending.isSuccess && pendingItems.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No pending invites.</div>
          )}
          {pendingItems.map((p, i) => {
            const inviteId = String(p.invite_id ?? p.email ?? i);
            return (
              <div key={inviteId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm">{p.email ?? 'Invitee'}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.project_role ?? 'member'}
                    {p.invite_expired ? ' · expired' : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resendInvite.isPending}
                    onClick={() => resendInvite.mutate(inviteId)}
                  >
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    disabled={revokeInvite.isPending}
                    onClick={() => revokeInvite.mutate(inviteId)}
                    aria-label="Revoke invite"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Access requests */}
      <Card className="p-0">
        <div className="px-5 pt-5 text-sm font-medium">Access requests</div>
        <div className="mt-2 divide-y divide-border">
          {requests.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-40" />
            </div>
          )}
          {requests.isSuccess && requestItems.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No pending requests.
            </div>
          )}
          {requestItems.map((r, i) => {
            const requestId = String(r.request_id ?? i);
            return (
              <div key={requestId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {r.requester_email ?? r.requester_user_id ?? 'Requester'}
                  </div>
                  {r.message && (
                    <div className="truncate text-xs text-muted-foreground">{r.message}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(requestId)}
                    aria-label="Approve"
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    disabled={reject.isPending}
                    onClick={() => reject.mutate(requestId)}
                    aria-label="Reject"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Group grants (read-only) */}
      <Card className="p-0">
        <div className="px-5 pt-5 text-sm font-medium">Group grants</div>
        <div className="mt-2 divide-y divide-border">
          {grants.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-40" />
            </div>
          )}
          {grants.isSuccess && grantItems.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No groups attached.</div>
          )}
          {grantItems.map((g, i) => (
            <div
              key={String(g.group_id ?? i)}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm">{g.group_name ?? g.group_id}</div>
                <div className="text-xs text-muted-foreground">
                  {typeof g.member_count === 'number' ? `${g.member_count} member(s)` : 'group'}
                  {g.created_at ? ` · ${relativeTime(g.created_at)}` : ''}
                </div>
              </div>
              <Badge variant="outline" className="capitalize">
                {g.role ?? 'member'}
              </Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
