'use client';

// Account-wide MFA enforcement toggle on the Settings tab. Off by default.
// When ON, every browser/JWT request whose session is not aal2 is denied
// at the IAM engine — super-admins are exempt (so the switch can't
// permanently lock the account), and PATs are exempt (they gate via
// per-policy require_mfa conditions instead).
//
// Safety: enable path always fetches the preview so the admin sees who
// would be locked out, and the backend refuses flips that would orphan
// the account.

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { getMfaRequired, previewMfaRequired, setMfaRequired } from '@/lib/iam-client';
import { listAccountMembers } from '@kortix/sdk/projects-client';

interface MfaRequiredCardProps {
  accountId: string;
  canManage: boolean;
}

export function MfaRequiredCard({ accountId, canManage }: MfaRequiredCardProps) {
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
      successToast(
        res.enabled ? 'MFA is now required for this account' : 'MFA requirement disabled',
      );
      queryClient.invalidateQueries({ queryKey: ['iam-mfa-required', accountId] });
      // Permission probes cache verdicts and the MFA gate flips them
      // wholesale — invalidate every probe so the UI re-resolves.
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
      setConfirmOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update MFA requirement'),
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
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            Require MFA for all members
            {!statusQuery.isLoading && enabled && (
              <Badge variant="success" size="sm">
                Required
              </Badge>
            )}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            When enabled, members must complete a second-factor challenge before any IAM-gated
            action. Super-admins and Personal Access Tokens are exempt.
          </p>
        </div>
        {statusQuery.isLoading ? (
          <Skeleton className="h-8 w-24 shrink-0 rounded-md" />
        ) : (
          <Button
            variant={enabled ? 'destructive' : 'secondary'}
            size="sm"
            disabled={!canManage || flipMutation.isPending}
            onClick={() => setConfirmOpen(true)}
            className="shrink-0 gap-1.5"
          >
            {flipMutation.isPending && <Loading className="size-3.5 shrink-0" />}
            {enabled ? 'Disable' : 'Require MFA'}
          </Button>
        )}
      </div>

      {/* Enable path */}
      <Modal
        open={confirmOpen && !enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
      >
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>Require MFA for this account?</ModalTitle>
            <ModalDescription>
              Members without a verified second factor will be blocked from every IAM-gated
              action until they enrol. CLI tokens (PATs) are unaffected.
            </ModalDescription>
          </ModalHeader>

          <ModalBody className="space-y-3">
            {previewQuery.isLoading && (
              <div className="rounded-md border px-3 py-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </div>
            )}

            {previewQuery.data && previewQuery.data.will_lock_out_account && (
              <InfoBanner tone="destructive" icon={AlertTriangle}>
                Nobody would retain access. Promote a super-admin or have at least one member
                enrol MFA before enabling.
              </InfoBanner>
            )}

            {previewQuery.data && !previewQuery.data.will_lock_out_account && (
              <InfoBanner tone="neutral">
                <span className="text-foreground font-medium">
                  {previewQuery.data.members_with_mfa}
                </span>{' '}
                of{' '}
                <span className="text-foreground font-medium">
                  {previewQuery.data.total_members}
                </span>{' '}
                members have MFA enrolled.
              </InfoBanner>
            )}

            {partitionedLosers.lockouts.length > 0 && (
              <InfoBanner
                tone="warning"
                icon={AlertTriangle}
                title={`${partitionedLosers.lockouts.length} ${partitionedLosers.lockouts.length === 1 ? 'member' : 'members'} will be locked out until they enrol MFA:`}
              >
                <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                  {partitionedLosers.lockouts.map((l) => (
                    <li key={l.user_id} className="flex items-center gap-2">
                      <span className="text-foreground truncate">
                        {emailByUserId.get(l.user_id) ?? l.user_id}
                      </span>
                      <span className="text-muted-foreground/80">·</span>
                      <span className="text-muted-foreground capitalize">{l.account_role}</span>
                    </li>
                  ))}
                </ul>
              </InfoBanner>
            )}

            {partitionedLosers.exemptAdmins.length > 0 && (
              <InfoBanner
                tone="neutral"
                title={
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" size="xs">
                      exempt
                    </Badge>
                    {partitionedLosers.exemptAdmins.length} super-admin
                    {partitionedLosers.exemptAdmins.length === 1 ? '' : 's'} without MFA — they
                    won&apos;t be locked out, but consider asking them to enrol:
                  </span>
                }
              >
                <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                  {partitionedLosers.exemptAdmins.map((l) => (
                    <li key={l.user_id} className="text-foreground truncate">
                      {emailByUserId.get(l.user_id) ?? l.user_id}
                    </li>
                  ))}
                </ul>
              </InfoBanner>
            )}
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <Button
              variant="outline-ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={flipMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => flipMutation.mutate(true)}
              disabled={
                flipMutation.isPending || previewQuery.data?.will_lock_out_account === true
              }
              className="gap-1.5"
            >
              {flipMutation.isPending && <Loading className="size-3.5 shrink-0" />}
              Require MFA
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Disable path */}
      <ConfirmDialog
        open={confirmOpen && enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
        title="Disable MFA requirement?"
        description="Members will be able to sign in with a password alone. Per-policy MFA conditions you may have set on individual policies still apply — only the account-wide gate is removed."
        confirmLabel="Disable MFA requirement"
        confirmVariant="destructive"
        isPending={flipMutation.isPending}
        onConfirm={() => flipMutation.mutate(false)}
      />
    </div>
  );
}
