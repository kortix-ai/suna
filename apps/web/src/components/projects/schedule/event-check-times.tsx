'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';

/** "2 min ago" / "in 3 min" in the viewer's locale; seconds read as now. */
export function relativeMinutes(iso: string, locale: string, now: number = Date.now()): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'short', numeric: 'auto' });
  const minutes = Math.round((at - now) / 60_000);
  if (minutes === 0) return rtf.format(0, 'second');
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  if (Math.abs(minutes) < 48 * 60) return rtf.format(Math.round(minutes / 60), 'hour');
  return rtf.format(Math.round(minutes / (24 * 60)), 'day');
}

/**
 * When Kortix last checked the app and checks it next, for a trigger it
 * checks itself (source `mcp`). Nothing for any other trigger.
 */
export function EventCheckTimes({ trigger, now }: { trigger: ProjectTrigger; now?: number }) {
  const t = useTranslations('triggerComposer');
  const locale = useLocale();
  const event = trigger.type === 'event' ? trigger.event : null;
  if (!event || (event.source ?? event.provider) !== 'mcp' || !trigger.enabled) return null;
  if (event.status !== 'active' && event.status !== 'error') return null;
  const checked = event.checked_at ? relativeMinutes(event.checked_at, locale, now) : null;
  const next = event.next_check_at ? relativeMinutes(event.next_check_at, locale, now) : null;
  const parts = [
    checked ? t('mcpCheckedAt', { when: checked }) : t('mcpNotChecked'),
    ...(next ? [t('mcpNextCheck', { when: next })] : []),
  ];
  return <p className="text-muted-foreground text-xs">{parts.join(' · ')}</p>;
}
