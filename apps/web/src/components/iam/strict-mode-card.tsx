'use client';

// Strict IAM mode toggle on the account Settings tab. Off by default:
// legacy account_role + project_members bridges stay active. Flipping ON
// makes IAM the single source of truth — only super-admin bypass and
// explicit policies grant access.
//
// Safety: we always fetch the preview before showing the confirm dialog so
// the admin sees who's about to lose access. The backend also refuses the
// flip if it would lock out the entire account.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getStrictMode,
  previewStrictMode,
  setStrictMode,
} from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

interface StrictModeCardProps {
  accountId: string;
  canManage: boolean;
}

export function StrictModeCard({ accountId, canManage }: StrictModeCardProps) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['iam-strict-mode', accountId],
    queryFn: () => getStrictMode(accountId),
    staleTime: 30_000,
  });

  // Only fetched when the confirm dialog opens — preview is for the
  // enable path; disabling is always safe (existing policies stay) so we
  // skip the preview there.
  const previewQuery = useQuery({
    queryKey: ['iam-strict-mode-preview', accountId],
    queryFn: () => previewStrictMode(accountId),
    enabled: confirmOpen && statusQuery.data?.enabled === false,
    staleTime: 0,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    enabled: confirmOpen && statusQuery.data?.enabled === false,
    staleTime: 30_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [membersQuery.data]);

  const flipMutation = useMutation({
    mutationFn: (enabled: boolean) => setStrictMode(accountId, enabled),
    onSuccess: (res) => {
      toast.success(res.enabled ? 'Strict IAM mode enabled' : 'Strict IAM mode disabled');
      queryClient.invalidateQueries({ queryKey: ['iam-strict-mode', accountId] });
      // Permission probes cache verdicts; bust the cache so the UI re-resolves
      // every gate under the new mode.
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
      setConfirmOpen(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update strict mode'),
  });

  const enabled = statusQuery.data?.enabled ?? false;

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              Strict IAM mode
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              When enabled, only super-admin bypass and explicit IAM policies grant
              access. Legacy owner/admin/member roles and project_members rows are
              ignored.
            </p>
          </div>
          {statusQuery.isLoading ? (
            <Skeleton className="h-9 w-24 rounded-md" />
          ) : (
            <Button
              variant={enabled ? 'destructive' : 'default'}
              disabled={!canManage || flipMutation.isPending}
              onClick={() => setConfirmOpen(true)}
              className="gap-1.5"
            >
              {flipMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {enabled ? 'Disable strict mode' : 'Enable strict mode'}
            </Button>
          )}
        </div>
      </header>
      <div className="px-6 py-4">
        <p className="text-sm">
          Status:{' '}
          {statusQuery.isLoading ? (
            <Skeleton className="inline-block h-4 w-16 align-middle" />
          ) : enabled ? (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">On</span>
          ) : (
            <span className="font-medium text-muted-foreground">Off (legacy bridges active)</span>
          )}
        </p>
      </div>

      {/* Enable path: show preview + confirm */}
      <Dialog
        open={confirmOpen && !enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Enable strict IAM mode?</DialogTitle>
            <DialogDescription>
              The legacy bridges (owner/admin/member roles, project_members rows)
              stop granting access. Only super-admin bypass and explicit IAM
              policies will work after this.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {previewQuery.isLoading && (
              <div className="rounded-md border border-border/60 px-3 py-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </div>
            )}

            {previewQuery.data && previewQuery.data.will_lock_out_account && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  Nobody would retain access. Promote a super-admin or create at
                  least one explicit policy before enabling.
                </p>
              </div>
            )}

            {previewQuery.data &&
              !previewQuery.data.will_lock_out_account &&
              previewQuery.data.losers.length === 0 && (
                <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                  No members will lose access — every member is super-admin or
                  has an explicit policy.
                </p>
              )}

            {previewQuery.data && previewQuery.data.losers.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-xs">
                <p className="mb-2 font-medium text-amber-700 dark:text-amber-400">
                  {previewQuery.data.losers.length}{' '}
                  {previewQuery.data.losers.length === 1 ? 'member' : 'members'} will
                  lose all access:
                </p>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                  {previewQuery.data.losers.map((l) => (
                    <li key={l.user_id} className="flex items-center gap-2">
                      <span className="truncate text-foreground">
                        {emailByUserId.get(l.user_id) ?? l.user_id}
                      </span>
                      <span className="text-muted-foreground/80">·</span>
                      <span className="capitalize text-muted-foreground">
                        {l.account_role}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={flipMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => flipMutation.mutate(true)}
              disabled={
                flipMutation.isPending || previewQuery.data?.will_lock_out_account === true
              }
              className="gap-1.5"
            >
              {flipMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Enable strict mode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable path: simpler confirm — no preview needed since existing
          policies are unaffected; bridges just come back as a fallback. */}
      <Dialog
        open={confirmOpen && enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable strict IAM mode?</DialogTitle>
            <DialogDescription>
              Legacy bridges resume granting access alongside your explicit
              policies. Owners/admins regain Administrator privileges, members
              regain account-level reads, and project_members rows act as
              fallbacks again. Existing policies are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={flipMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => flipMutation.mutate(false)}
              disabled={flipMutation.isPending}
              className="gap-1.5"
            >
              {flipMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Disable strict mode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
