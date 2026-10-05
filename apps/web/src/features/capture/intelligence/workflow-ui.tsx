'use client';

import type { CaptureWorkflowStatus } from '@kortix/sdk';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

/** `7 m 40 s`, `26 m`, `1 h 5 m`: one run's length. */
export function useRunDuration() {
  const t = useTranslations('capture.duration');
  return (seconds: number) => {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return t('seconds', { seconds: s });
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    if (hours > 0) return t('hoursMinutes', { hours, minutes });
    const rest = s % 60;
    return rest && minutes < 10
      ? t('minutesSeconds', { minutes, seconds: rest })
      : t('minutes', { minutes });
  };
}

/** `5.2` in the locale: hours a week, one decimal. */
export function useHours() {
  const locale = useLocale();
  return (hours: number) =>
    hours.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** `88%` in the locale. */
export function usePercent() {
  const locale = useLocale();
  return (share: number) =>
    share.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 });
}

/** Detected → Reviewed → Skill exported. */
export function WorkflowStatusBadge({ status }: { status: CaptureWorkflowStatus }) {
  const t = useTranslations('capture.workflows');
  return (
    <Badge
      size="sm"
      variant={status === 'exported' ? 'solid' : status === 'reviewed' ? 'default' : 'outline'}
      className="normal-case"
    >
      {t(`status.${status}`)}
    </Badge>
  );
}

/** A share bar: hours a week an agent could take, against the largest in view. */
export function ShareBar({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span
      aria-hidden
      className={`bg-muted flex h-1.5 min-w-12 flex-1 overflow-hidden rounded-full ${className ?? ''}`}
    >
      <span className="bg-foreground rounded-full" style={{ width: `${width}%` }} />
    </span>
  );
}

/**
 * Nothing found yet: workflows come from many recorded episodes. Says what is
 * recorded so far and what happens next, instead of an empty table.
 */
export function LearningState({ hoursRecorded }: { hoursRecorded: number | null }) {
  const t = useTranslations('capture.workflows');
  const hours = useHours();
  return (
    <EmptyState
      size="sm"
      title={t('learning.title')}
      description={
        hoursRecorded === null
          ? t('learning.body')
          : t('learning.bodyWithHours', { hours: hours(hoursRecorded) })
      }
    />
  );
}
