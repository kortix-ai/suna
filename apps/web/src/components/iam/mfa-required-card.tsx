'use client';

import { useTranslations } from '@/i18n/use-translations';
// Account-wide MFA enforcement toggle on the Settings tab. Off by default.
// When ON, every browser/JWT request whose session is not aal2 is denied
// at the IAM engine — super-admins are exempt (so the switch can't
// permanently lock the account), and PATs are exempt (they gate via
// per-policy require_mfa conditions instead).
//
// Safety: enable path always fetches the preview so the admin sees who
// would be locked out, and the backend refuses flips that would orphan
// the account.
//
// **Renders a bare `SettingsRow` — mount it inside a `SettingsRowGroup`.**
// It used to draw its own `bg-popover rounded-md border` box, which is why
// the organization pane read as four unrelated cards instead of one settings
// form. It is a ROW now, in the Linear shape every other pane on this branch
// uses (`components/ui/settings-row.tsx`); the group that hosts it owns the
// border and the hairlines. `key-rules-card.tsx` made the same move first.
//
// The control is a `Switch`, not the old Require/Disable button pair. Both
// confirmation surfaces are unchanged and still gate every flip — the switch
// only opens them, and does not move until the mutation actually lands, so
// what it shows is always the server's answer.

import { errorToast, successToast } from '@/components/ui/toast';
import { WarningIcon as AlertTriangle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { SettingsRow } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { getMfaRequired, previewMfaRequired, setMfaRequired } from '@/lib/iam-client';
import { listAccountMembers } from '@kortix/sdk';

interface MfaRequiredCardProps {
  accountId: string;
  canManage: boolean;
}

export function MfaRequiredCard({ accountId, canManage }: MfaRequiredCardProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        res.enabled ? tI18nComplete.raw('text385ec5e81a2c') : tI18nComplete.raw('texteffc26c96de0'),
      );
      queryClient.invalidateQueries({ queryKey: ['iam-mfa-required', accountId] });
      // Permission probes cache verdicts and the MFA gate flips them
      // wholesale — invalidate every probe so the UI re-resolves.
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
      setConfirmOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textd46bb949f04b')),
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
    <>
      <SettingsRow
        label={tI18nComplete.raw('text80b64b2966be')}
        // One line, and only the part an admin decides on. Where a member
        // enrols is the member's problem, and it is answered on the Profile
        // pane where they do it — it does not belong in this row.
        description={tI18nComplete.raw('textd45f25a6299a')}
      >
        {statusQuery.isLoading ? (
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        ) : (
          <>
            {flipMutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            <Switch
              checked={enabled}
              // Never flips optimistically: the confirmation below decides,
              // and the query invalidation after it lands is what moves this.
              onCheckedChange={() => setConfirmOpen(true)}
              disabled={!canManage || flipMutation.isPending}
              aria-label={tI18nComplete.raw('text80b64b2966be')}
              className="shrink-0"
            />
          </>
        )}
      </SettingsRow>

      {/* Enable path */}
      <Modal
        open={confirmOpen && !enabled}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
      >
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('text563038dc7264')}</ModalTitle>
            {/* Same words as the row that opens this — "protected action" and
                "API keys", not "IAM-gated action" and "PATs". A confirmation
                that renames what you just read is a confirmation you have to
                re-read. */}
            <ModalDescription>{tI18nComplete.raw('text08a608865569')}</ModalDescription>
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
                {tI18nComplete.raw('text62dd34b5892f')}
              </InfoBanner>
            )}

            {previewQuery.data && !previewQuery.data.will_lock_out_account && (
              <InfoBanner tone="neutral">
                <span className="text-foreground font-medium">
                  {previewQuery.data.members_with_mfa}
                </span>{' '}
                {tI18nComplete.raw('text28391d3bc64e')}{' '}
                <span className="text-foreground font-medium">
                  {previewQuery.data.total_members}
                </span>{' '}
                {tI18nComplete.raw('texta8d4a1d5bb6d')}
              </InfoBanner>
            )}

            {partitionedLosers.lockouts.length > 0 && (
              <InfoBanner
                tone="warning"
                icon={AlertTriangle}
                title={tI18nComplete('text2be1f843485e', {
                  value0: partitionedLosers.lockouts.length,
                  value1: partitionedLosers.lockouts.length === 1 ? 'member' : 'members',
                })}
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
                      {tI18nComplete.raw('text42d8a7ea9caf')}
                    </Badge>
                    {partitionedLosers.exemptAdmins.length} {tI18nComplete.raw('text11c520bc9f1f')}
                    {partitionedLosers.exemptAdmins.length === 1 ? '' : 's'}{' '}
                    {tI18nComplete.raw('textdc78f4d17256')}
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
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button
              size="sm"
              onClick={() => flipMutation.mutate(true)}
              disabled={flipMutation.isPending || previewQuery.data?.will_lock_out_account === true}
              className="gap-1.5"
            >
              {flipMutation.isPending && <Loading className="size-3.5 shrink-0" />}
              {tI18nComplete.raw('text644381187e8b')}
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
        title={tI18nComplete.raw('textf2e8cb47665e')}
        description={tI18nComplete.raw('text1c1a67e4558f')}
        confirmLabel={tI18nComplete.raw('texta89a654b8541')}
        confirmVariant="destructive"
        isPending={flipMutation.isPending}
        onConfirm={() => flipMutation.mutate(false)}
      />
    </>
  );
}
