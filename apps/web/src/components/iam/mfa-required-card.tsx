'use client';

import { useTranslations } from 'next-intl';
// Account-wide MFA enforcement toggle on the Settings tab. Off by default.
// When ON, every browser/JWT request whose session is not aal2 is denied
// at the IAM engine — super-admins are exempt (so the switch can't
// permanently lock the account), and PATs are exempt (they gate via
// per-policy require_mfa conditions instead).
//
// Safety: enable path always fetches the preview so the admin sees who
// would be locked out, and the backend refuses flips that would orphan
// the account.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Badge } from '@/components/ui/badge';
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
  getMfaRequired,
  previewMfaRequired,
  setMfaRequired,
} from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

interface MfaRequiredCardProps {
  accountId: string;
  canManage: boolean;
}

export function MfaRequiredCard({ accountId, canManage }: MfaRequiredCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['iam-mfa-required', accountId],
    queryFn: () => getMfaRequired(accountId),
    staleTime: 30_000,
  });

  // Preview is only relevant on the enable path; disabling is always
  // safe (nobody can be newly locked out by relaxing the gate).
  const previewQuery = useQuery({
    queryKey: ['iam-mfa-required-preview', accountId],
    queryFn: () => previewMfaRequired(accountId),
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
    mutationFn: (enabled: boolean) => setMfaRequired(accountId, enabled),
    onSuccess: (res) => {
      toast.success(
        res.enabled
          ? 'MFA is now required for this account'
          : 'MFA requirement disabled',
      );
      queryClient.invalidateQueries({ queryKey: ['iam-mfa-required', accountId] });
      // Permission probes cache verdicts and the MFA gate flips them
      // wholesale — invalidate every probe so the UI re-resolves.
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
      setConfirmOpen(false);
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to update MFA requirement'),
  });

  const enabled = statusQuery.data?.enabled ?? false;

  // Partition the losers list into "actual lockouts" (non-super-admins)
  // and "super-admins exempt from enforcement, but still worth nudging".
  const partitionedLosers = useMemo(() => {
    const data = previewQuery.data;
    if (!data) return { lockouts: [], exemptAdmins: [] };
    const lockouts: typeof data.losers = [];
    const exemptAdmins: typeof data.losers = [];
    for (const l of data.losers) {
      (l.is_super_admin ? exemptAdmins : lockouts).push(l);
    }
    return { lockouts, exemptAdmins };
  }, [previewQuery.data]);

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {tHardcodedUi.raw('componentsIamMfaRequiredCard.line116JsxTextRequireMFAForAllMembers')}
              {!statusQuery.isLoading && enabled && (
                <Badge
                  variant="outline"
                  size="sm"
                  className="border-emerald-500/40 bg-emerald-500/10 text-[10px] font-normal text-emerald-700 dark:text-emerald-300"
                >
                  required
                </Badge>
              )}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamMfaRequiredCard.line119JsxTextWhenEnabledMembersMustCompleteASecondFactor')}</p>
          </div>
          {statusQuery.isLoading ? (
            <Skeleton className="h-9 w-24 rounded-md" />
          ) : (
            <Button
              variant={enabled ? 'destructive' : 'default'}
              disabled={!canManage || flipMutation.isPending}
              onClick={() => setConfirmOpen(true)}
              className="shrink-0 gap-1.5"
            >
              {flipMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {enabled ? 'Disable' : 'Require MFA'}
            </Button>
          )}
        </div>
      </header>

      {/* Enable path */}
      <Dialog
        open={confirmOpen && !enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tHardcodedUi.raw('componentsIamMfaRequiredCard.line165JsxTextRequireMFAForThisAccount')}</DialogTitle>
            <DialogDescription>
              {tHardcodedUi.raw('componentsIamMfaRequiredCard.line167JsxTextMembersWithoutAVerifiedSecondFactorWillBe')}</DialogDescription>
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
                  {tHardcodedUi.raw('componentsIamMfaRequiredCard.line185JsxTextNobodyWouldRetainAccessPromoteASuperAdmin')}</p>
              </div>
            )}

            {previewQuery.data && !previewQuery.data.will_lock_out_account && (
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {previewQuery.data.members_with_mfa}
                </span>{' '}
                of{' '}
                <span className="font-medium text-foreground">
                  {previewQuery.data.total_members}
                </span>{' '}
                {tHardcodedUi.raw('componentsIamMfaRequiredCard.line200JsxTextMembersHaveMFAEnrolled')}</div>
            )}

            {partitionedLosers.lockouts.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-xs">
                <p className="mb-2 font-medium text-amber-700 dark:text-amber-400">
                  {partitionedLosers.lockouts.length}{' '}
                  {partitionedLosers.lockouts.length === 1 ? 'member' : 'members'} {tHardcodedUi.raw('componentsIamMfaRequiredCard.line208JsxTextWillBeLockedOutUntilTheyEnrolMFA')}</p>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                  {partitionedLosers.lockouts.map((l) => (
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

            {partitionedLosers.exemptAdmins.length > 0 && (
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-xs">
                <p className="mb-2 flex items-center gap-1.5 text-muted-foreground">
                  <Badge variant="outline" size="sm" className="text-[9px]">
                    exempt
                  </Badge>
                  {partitionedLosers.exemptAdmins.length} super-admin
                  {partitionedLosers.exemptAdmins.length === 1 ? '' : 's'} {tHardcodedUi.raw('componentsIamMfaRequiredCard.line234JsxTextWithoutMFATheyWonTBeLockedOut')}</p>
                <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                  {partitionedLosers.exemptAdmins.map((l) => (
                    <li key={l.user_id} className="truncate text-foreground">
                      {emailByUserId.get(l.user_id) ?? l.user_id}
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
                flipMutation.isPending ||
                previewQuery.data?.will_lock_out_account === true
              }
              className="gap-1.5"
            >
              {flipMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {tHardcodedUi.raw('componentsIamMfaRequiredCard.line266JsxTextRequireMFA')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable path */}
      <Dialog
        open={confirmOpen && enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tHardcodedUi.raw('componentsIamMfaRequiredCard.line281JsxTextDisableMFARequirement')}</DialogTitle>
            <DialogDescription>
              {tHardcodedUi.raw('componentsIamMfaRequiredCard.line283JsxTextMembersWillBeAbleToSignInWith')}</DialogDescription>
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
              {tHardcodedUi.raw('componentsIamMfaRequiredCard.line303JsxTextDisableMFARequirement')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
