'use client';

// Session controls on the Settings tab: per-account max-lifetime + idle
// timeout, plus an "active sessions" panel with force-logout. PATs are
// not represented here — they have their own lifecycle policies.

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, LogOut } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  type ActiveSession,
  type SessionPolicy,
  getSessionPolicy,
  listAccountSessions,
  revokeAccountSession,
  updateSessionPolicy,
} from '@/lib/iam-client';
import { listAccountMembers } from '@kortix/sdk/projects-client';

const MAX_MINUTES = 10080; // 7 days, matches the server cap

interface SessionControlsCardProps {
  accountId: string;
  canManage: boolean;
}

export function SessionControlsCard({ accountId, canManage }: SessionControlsCardProps) {
  const queryClient = useQueryClient();
  const [revokeTarget, setRevokeTarget] = useState<ActiveSession | null>(null);

  const policyQuery = useQuery({
    queryKey: ['iam-session-policy', accountId],
    queryFn: () => getSessionPolicy(accountId),
    staleTime: 30_000,
  });

  const sessionsQuery = useQuery({
    queryKey: ['iam-sessions', accountId],
    queryFn: () => listAccountSessions(accountId),
    staleTime: 15_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 60_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [membersQuery.data]);

  // Local form state — string-typed so an empty input means "no limit".
  const [maxLifetime, setMaxLifetime] = useState('');
  const [idleTimeout, setIdleTimeout] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!policyQuery.data) return;
    setMaxLifetime(policyQuery.data.max_lifetime_minutes?.toString() ?? '');
    setIdleTimeout(policyQuery.data.idle_timeout_minutes?.toString() ?? '');
  }, [policyQuery.data]);

  function parseField(label: string, raw: string): number | null | { err: string } {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) {
      return { err: `${label} must be a positive integer or blank` };
    }
    if (n > MAX_MINUTES) {
      return { err: `${label} cannot exceed ${MAX_MINUTES} minutes (7 days)` };
    }
    return n;
  }

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<SessionPolicy>) => updateSessionPolicy(accountId, patch),
    onSuccess: () => {
      successToast('Session policy updated');
      queryClient.invalidateQueries({ queryKey: ['iam-session-policy', accountId] });
      setError(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update policy'),
  });

  function handleSave() {
    const max = parseField('Max lifetime', maxLifetime);
    if (typeof max === 'object' && max && 'err' in max) {
      setError(max.err);
      return;
    }
    const idle = parseField('Idle timeout', idleTimeout);
    if (typeof idle === 'object' && idle && 'err' in idle) {
      setError(idle.err);
      return;
    }
    setError(null);
    saveMutation.mutate({
      max_lifetime_minutes: max as number | null,
      idle_timeout_minutes: idle as number | null,
    });
  }

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => revokeAccountSession(accountId, sessionId),
    onSuccess: () => {
      successToast('Session revoked');
      queryClient.invalidateQueries({ queryKey: ['iam-sessions', accountId] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to revoke session'),
  });

  const sessions = sessionsQuery.data ?? [];

  // Partition: live (no revoked_at) vs already-revoked, so the UI puts
  // active ones at the top and de-emphasises the rest.
  const partitioned = useMemo(() => {
    const live: ActiveSession[] = [];
    const revoked: ActiveSession[] = [];
    for (const s of sessions) {
      (s.revoked_at ? revoked : live).push(s);
    }
    return { live, revoked };
  }, [sessions]);

  return (
    <div className="space-y-5">
      {/* Policy form */}
      <div className="bg-popover rounded-md border">
        <div className="space-y-4 px-4 py-5">
          {policyQuery.isLoading ? (
            <Skeleton className="h-24 w-full rounded-md" />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Max session lifetime (minutes)</Label>
                <Input
                  value={maxLifetime}
                  onChange={(e) => setMaxLifetime(e.target.value)}
                  placeholder="leave blank for no max"
                  inputMode="numeric"
                  disabled={!canManage || saveMutation.isPending}
                  variant="popover"
                />
                <p className="text-muted-foreground text-xs">
                  Forces a fresh sign-in after this many minutes, measured from when the access
                  token was issued.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Idle timeout (minutes)</Label>
                <Input
                  value={idleTimeout}
                  onChange={(e) => setIdleTimeout(e.target.value)}
                  placeholder="leave blank for no idle gate"
                  inputMode="numeric"
                  disabled={!canManage || saveMutation.isPending}
                  variant="popover"
                />
                <p className="text-muted-foreground text-xs">
                  Kills the session after this many minutes of no activity against this account.
                </p>
              </div>
            </div>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        {canManage && (
          <div className="border-border flex items-center justify-end border-t px-4 py-3">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="gap-1.5"
            >
              {saveMutation.isPending && <Loading className="size-3.5 shrink-0" />}
              Save
            </Button>
          </div>
        )}
      </div>

      {/* Active sessions */}
      <div className="space-y-3">
        <p className="text-foreground text-sm font-medium">Active sessions</p>
        {sessionsQuery.isLoading ? (
          <Skeleton className="h-16 w-full rounded-md" />
        ) : partitioned.live.length === 0 && partitioned.revoked.length === 0 ? (
          <EmptyState
            icon={Clock}
            size="sm"
            title="No sessions tracked yet"
            description="Sessions show up here the first time a member hits an account-scoped route while a policy is configured."
          />
        ) : (
          <div className="space-y-3">
            <SessionsTable
              rows={partitioned.live}
              emailByUserId={emailByUserId}
              canManage={canManage}
              onRevoke={(s) => setRevokeTarget(s)}
              muted={false}
            />
            {partitioned.revoked.length > 0 && (
              <details className="rounded-md border px-3 py-2 text-xs">
                <summary className="text-muted-foreground cursor-pointer">
                  Revoked / expired ({partitioned.revoked.length})
                </summary>
                <div className="mt-3">
                  <SessionsTable
                    rows={partitioned.revoked}
                    emailByUserId={emailByUserId}
                    canManage={false}
                    onRevoke={() => {}}
                    muted
                  />
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title="Force-logout this session?"
        description={
          revokeTarget
            ? `The user (${emailByUserId.get(revokeTarget.user_id) ?? revokeTarget.user_id}) will get 401 on their next request to this account and must sign in again.`
            : ''
        }
        confirmLabel="Force-logout"
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.session_id);
        }}
      />
    </div>
  );
}

// ─── Sessions table ───────────────────────────────────────────────────────

function SessionsTable({
  rows,
  emailByUserId,
  canManage,
  onRevoke,
  muted,
}: {
  rows: ActiveSession[];
  emailByUserId: Map<string, string>;
  canManage: boolean;
  onRevoke: (s: ActiveSession) => void;
  muted: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">No active sessions.</p>;
  }

  return (
    <Table className={muted ? 'opacity-60' : undefined}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Member</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>IP</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => (
          <TableRow key={`${s.user_id}|${s.session_id}`} className={muted ? 'hover:bg-transparent' : undefined}>
            <TableCell className="text-foreground text-xs">
              {emailByUserId.get(s.user_id) ?? (
                <span className="text-muted-foreground font-mono text-xs">{s.user_id}</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {formatRelative(s.last_seen_at)}
            </TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs">
              {s.ip ?? '—'}
            </TableCell>
            <TableCell>
              {s.revoked_at ? (
                <Badge variant="muted" size="sm">
                  {s.revoked_reason ?? 'revoked'}
                </Badge>
              ) : (
                <Badge variant="success" size="sm">
                  active
                </Badge>
              )}
            </TableCell>
            <TableCell>
              {canManage && !s.revoked_at && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onRevoke(s)}
                  aria-label="Force-logout"
                >
                  <LogOut className="size-3.5 shrink-0" />
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return date.toLocaleDateString();
}
