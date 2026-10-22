'use client';

import { useMemo } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

/** Missing legacy schedules stay unknown rather than borrowing a renewal date. */
export function CreditExpiry({ expiresAt }: { expiresAt?: string | null }) {
  const locale = useLocale();
  const t = useTranslations('settings.credits');
  const format = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return (
    <p className="text-muted-foreground mt-1.5 text-xs">
      {t('resetAt')}{' '}
      <time dateTime={expiresAt}>
        {format.format(new Date(expiresAt))}
      </time>
    </p>
  );
}
