'use client';

import { WarningIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useTranslations } from '@/i18n/use-translations';

/**
 * A stored value Kortix can no longer decrypt (`status: 'undecryptable'`,
 * KRTX-1719): the encryption key changed, or the row is damaged. It reads as
 * broken, never as set. `onReenter` opens the row's own edit dialog; omit it
 * for a viewer who cannot write the value, and the hint names who can.
 */
export function UndecryptableValue({ onReenter }: { onReenter?: () => void }) {
  const t = useTranslations('secrets.undecryptable');
  return (
    <div className="flex flex-col items-start gap-1">
      <Hint label={t('hint')} side="top">
        <Badge variant="warning" size="sm" tabIndex={0}>
          <WarningIcon />
          {t('badge')}
        </Badge>
      </Hint>
      {onReenter ? (
        <Button size="sm" variant="secondary" onClick={onReenter}>
          {t('reenter')}
        </Button>
      ) : null}
    </div>
  );
}
