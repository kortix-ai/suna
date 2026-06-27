'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Mail, Send, Trash2, Users, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type Role = 'manager' | 'editor' | 'viewer';
const ROLES: Role[] = ['manager', 'editor', 'viewer'];

export function MembersTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const base = ['project-access', projectId] as const;
  const membersKey = base;
  const requestsKey = [...base, 'requests'] as const;
  const pendingKey = [...base, 'pending'] as const;
  const grantsKey = [...base, 'grants'] as const;

  const access = useQuery({
    queryKey: membersKey,
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
  const [inviteRole, setInviteRole] = useState<Role>('viewer');

  const invite = useMutation({
    mutationFn: () =>
      kortix.project(projectId).access.invite(email.trim(), inviteRole),
    onSuccess: () => {
      setEmail('');
      qc.invalidateQueries({ queryKey: membersKey });
      qc.invalidateQueries({ queryKey: pendingKey });
      toast.success('Invitation sent');
    },
    onError: () => toast.error('Could not invite'),
  });

  const updateRole = useMutation({
    mutationFn: (v: { userId: string; role: Role }) =>
      kortix.project(projectId).access.update(v.userId, v.role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersKey });
      toast.success('Role updated');
    },
    onError: () => toast.error('Could not update role'),
  });

  const revoke = useMutation({
    mutationFn: (userId: string) =>
      kortix.project(projectId).access.revoke(userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersKey });
      toast.success('Access revoked');
    },
    onError: () => toast.error('Could not revoke'),
  });

  const approve = useMutation({
    mutationFn: (requestId: string) =>
      kortix.project(projectId).access.approveRequest(requestId, 'viewer'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: requestsKey });
      qc.invalidateQueries({ queryKey: membersKey });
      toast.success('Request approved');
    },
    onError: () => toast.error('Could not approve'),
  });

  const reject = useMutation({
    mutationFn: (requestId: string) =>
      kortix.project(projectId).access.rejectRequest(requestId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: requestsKey });
      toast.success('Request rejected');
    },
    onError: () => toast.error('Could not reject'),
  });

  const resendInvite = useMutation({
    mutationFn: (inviteId: string) =>
      kortix.project(projectId).access.resendInvite(inviteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pendingKey });
      toast.success('Invite resent');
    },
    onError: () => toast.error('Could not resend'),
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      kortix.project(projectId).access.revokeInvite(inviteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pendingKey });
      toast.success('Invite revoked');
    },
    onError: () => toast.error('Could not revoke invite'),
  });

  const accessData = access.data as any;
  const members: any[] = Array.isArray(accessData)
    ? accessData
    : (accessData?.members ?? []);
  const requestItems: any[] = ((requests.data as any)?.requests ?? []).filter(
    (r: any) => (r?.status ?? 'pending') === 'pending',
  );
  const pendingItems: any[] = (pending.data as any)?.pending ?? [];
  const grantItems: any[] = (grants.data as any)?.grants ?? [];

  return (
    <div className="space-y-4">
      {/* Invite */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Mail className="size-4 text-brand" /> Invite a member
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
            {invite.isPending && <Loader2 className="size-4 animate-spin" />}
            Invite
          </Button>
        </form>
      </Card>

      {/* Members */}
      <Card className="p-0">
        <div className="flex items-center gap-2 px-5 pt-5 text-sm font-medium">
          <Users className="size-4 text-brand" /> Members
        </div>
        <div className="mt-2 divide-y divide-border">
          {access.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-48" />
            </div>
          )}
          {access.isSuccess && members.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Just you so far.
            </div>
          )}
          {members.map((m, i) => {
            const userId = String(m.user_id ?? m.email ?? i);
            const role: Role = (m.effective_project_role ??
              m.project_role ??
              'viewer') as Role;
            const implicit = Boolean(m.has_implicit_access);
            return (
              <div
                key={userId}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {m.email ?? m.user_id ?? 'Member'}
                  </div>
                  {m.effective_source && (
                    <div className="text-xs text-muted-foreground">
                      via {m.effective_source}
                    </div>
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
                      onValueChange={(v) =>
                        updateRole.mutate({ userId, role: v as Role })
                      }
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
          <Send className="size-4 text-brand" /> Pending invites
        </div>
        <div className="mt-2 divide-y divide-border">
          {pending.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-40" />
            </div>
          )}
          {pending.isSuccess && pendingItems.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No pending invites.
            </div>
          )}
          {pendingItems.map((p, i) => {
            const inviteId = String(p.invite_id ?? p.email ?? i);
            return (
              <div
                key={inviteId}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{p.email ?? 'Invitee'}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.project_role ?? 'viewer'}
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
              <div
                key={requestId}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {r.requester_email ?? r.requester_user_id ?? 'Requester'}
                  </div>
                  {r.message && (
                    <div className="truncate text-xs text-muted-foreground">
                      {r.message}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 text-brand"
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
            <div className="p-6 text-center text-sm text-muted-foreground">
              No groups attached.
            </div>
          )}
          {grantItems.map((g, i) => (
            <div
              key={String(g.group_id ?? i)}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm">{g.group_name ?? g.group_id}</div>
                <div className="text-xs text-muted-foreground">
                  {typeof g.member_count === 'number'
                    ? `${g.member_count} member(s)`
                    : 'group'}
                  {g.created_at ? ` · ${relativeTime(g.created_at)}` : ''}
                </div>
              </div>
              <Badge variant="outline" className="capitalize">
                {g.role ?? 'viewer'}
              </Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
