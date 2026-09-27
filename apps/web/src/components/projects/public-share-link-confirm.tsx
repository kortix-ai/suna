'use client';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTranslations } from '@/i18n/use-translations';

export interface PublicShareLinkConfirmation {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
}

/**
 * The confirmation in front of every public link. The link needs no sign-in,
 * so creating one is a decision, not a copy: "Copy link" opens this, and only
 * "Create link" mints the share and copies it.
 */
export function PublicShareLinkConfirm({
  confirmation,
}: {
  confirmation: PublicShareLinkConfirmation;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <ConfirmDialog
      open={confirmation.open}
      onOpenChange={confirmation.onOpenChange}
      title={tHardcodedUi.raw('publicShareConfirm.title')}
      description={tHardcodedUi.raw('publicShareConfirm.description')}
      confirmLabel={tHardcodedUi.raw('publicShareConfirm.confirm')}
      onConfirm={confirmation.onConfirm}
      isPending={confirmation.isPending}
    />
  );
}
