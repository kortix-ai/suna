'use client';

import { WarningIcon } from '@phosphor-icons/react';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import Hint from '../../../primitives/hint';
import { useTranslations } from '../../../i18n';

/**
 * A stored value Kortix can no longer decrypt (`status: 'undecryptable'`,
 * KRTX-1719): the encryption key changed, or the row is damaged. It reads as
 * broken, never as set. `hint` says who fixes it (the project-secret hint when
 * omitted). `onAction` is the fix, labelled `actionLabel` ("Re-enter value"
 * when omitted); leave it out for a viewer who cannot fix the value.
 */
export function UndecryptableValue({
  hint,
  actionLabel,
  onAction,
  pending = false,
}: {
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  pending?: boolean;
}) {
  const t = useTranslations('secrets.undecryptable');
  return (
    <div className="flex flex-col items-start gap-1">
      <Hint label={hint ?? t('hint')} side="top">
        <Badge variant="warning" size="sm" tabIndex={0}>
          <WarningIcon />
          {t('badge')}
        </Badge>
      </Hint>
      {onAction ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={onAction}>
          {actionLabel ?? t('reenter')}
        </Button>
      ) : null}
    </div>
  );
}
