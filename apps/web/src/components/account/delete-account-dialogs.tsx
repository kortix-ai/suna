'use client';

/**
 * The account-deletion dialogs, shared by the two danger zones that can end
 * an account: the Profile tab (personal settings) and the account hub's
 * Danger-zone card. One flow, one copy source, one set of mutations — the
 * surfaces differ only in the row that opens the dialogs.
 *
 * The copy comes straight from the `settings.profile` namespace: the dialog
 * shipped there first and every locale already carries it. A scoped
 * `accountId` targets that account (the hub's case); omit it to act on the
 * caller's own account (the Profile tab's case) — the server resolves and
 * authorizes either way, so the dialogs never branch on which surface opened
 * them.
 */

import { useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import type { AccountDeletionMutationResult } from '@kortix/sdk';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
  useRequestAccountDeletion,
} from '@/hooks/account/use-account-deletion';

export type DeletionType = 'grace-period' | 'immediate';

/** `{date}` label builder for the "scheduled for deletion on {date}" line,
 *  shared by both surfaces' row copy. */
export function formatDeletionDate(
  value: string | null | undefined,
  locale: string,
): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(value));
}

interface ScopedDialogProps {
  open: boolean;
  /** The account the dialog acts on; omit for the caller's own account. */
  accountId?: string;
  onClose: () => void;
  /** Immediate deletion succeeded. The hub leaves a deleted account it does
   *  not own the identity of; the Profile tab needs nothing (its own deletion
   *  signs the user out). */
  onDeleted?: (result: AccountDeletionMutationResult) => void;
}

export function DeleteAccountDialog({ open, onClose, accountId, onDeleted }: ScopedDialogProps) {
  const t = useTranslations('settings.profile');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const requestDeletion = useRequestAccountDeletion(accountId);
  const deleteImmediately = useDeleteAccountImmediately(accountId);
  const [deletionType, setDeletionType] = useState<DeletionType>('grace-period');
  const [confirmText, setConfirmText] = useState('');

  const close = () => {
    onClose();
    setConfirmText('');
    setDeletionType('grace-period');
  };

  const handleConfirm = async () => {
    try {
      if (deletionType === 'immediate') {
        const result = await deleteImmediately.mutateAsync();
        onDeleted?.(result);
      } else {
        await requestDeletion.mutateAsync('User requested deletion');
      }
      close();
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent className="lg:max-w-md" variant="base">
        <ModalHeader>
          <ModalTitle>{t('deleteDialogTitle')}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <InfoBanner tone="warning">
            {deletionType === 'immediate' ? t('immediateWarning') : t('gracePeriodWarning')}
          </InfoBanner>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('whenDeleted')}</p>
            <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
              <li>{t('agentsDeleted')}</li>
              <li>{t('threadsDeleted')}</li>
              <li>{t('credentialsDeleted')}</li>
              <li>{t('subscriptionCancelled')}</li>
              <li>{t('billingHistoryRemoved')}</li>
            </ul>
          </div>
          <div className="space-y-3">
            <Label className="text-sm">{t('chooseWhen')}</Label>
            <RadioGroup
              value={deletionType}
              onValueChange={(value) => setDeletionType(value as DeletionType)}
            >
              <RadioGroupItem
                value="grace-period"
                id="delete-account-grace-period"
                label={t('gracePeriodLabel')}
                description={t('gracePeriodDescription')}
                size="lg"
                variant="outline"
              />
              <RadioGroupItem
                value="immediate"
                id="delete-account-immediate"
                label={t('immediateLabel')}
                description={t('immediateDescription')}
                size="lg"
                variant="outline"
              />
            </RadioGroup>
          </div>
          <div className="space-y-2">
            <Label htmlFor="delete-account-confirm" className="text-sm">
              {t('typeDeleteToConfirm')}
            </Label>
            <Input
              type="text"
              id="delete-account-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={tI18nComplete.raw('text6197595503f0')}
              autoComplete="off"
            />
          </div>
        </ModalBody>
        <ModalFooter className="w-full sm:justify-between">
          <Button variant="outline-ghost" onClick={close} className="w-full sm:w-auto">
            {t('keepAccount')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={
              (requestDeletion.isPending || deleteImmediately.isPending) ||
              confirmText !== 'delete'
            }
            className="w-full sm:w-auto"
          >
            {requestDeletion.isPending || deleteImmediately.isPending
              ? t('processing')
              : t('deleteAccount')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** "Keep my account" — cancels a scheduled deletion. */
export function CancelAccountDeletionDialog({ open, onClose, accountId }: ScopedDialogProps) {
  const t = useTranslations('settings.profile');
  const cancelDeletion = useCancelAccountDeletion(accountId);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('keepAccountTitle')}
      description={t('keepAccountDescription')}
      confirmLabel={t('keepMyAccount')}
      isPending={cancelDeletion.isPending}
      onConfirm={async () => {
        try {
          await cancelDeletion.mutateAsync();
          onClose();
        } catch {
          // Mutation onError already shows the user-facing message.
        }
      }}
    />
  );
}
