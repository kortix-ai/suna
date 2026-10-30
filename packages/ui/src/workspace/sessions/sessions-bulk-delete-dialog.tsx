'use client';

import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { RESTORE_DAYS } from '../../session/actions/session-delete-modal';
import { useTranslations } from '../../i18n';

import { bulkDeleteConfirmLabel } from './project-sessions-helpers';

/** The Sessions page's confirm for deleting the selected sessions. */
export function SessionsBulkDeleteDialog({
  count,
  open,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  count: number;
  open: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('sessionDelete');
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !isPending && onOpenChange(next)}
      title={tI18nComplete('text7ed6733a3900', {
        value0: count,
        value1: count === 1 ? 'session' : 'sessions',
      })}
      description={t('bulkDescription', { days: RESTORE_DAYS })}
      confirmLabel={bulkDeleteConfirmLabel(count, tI18nComplete)}
      confirmVariant="destructive"
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
