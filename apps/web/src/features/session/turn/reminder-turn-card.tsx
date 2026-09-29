'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Badge } from '@/components/ui/badge';
import { useTranslations } from '@/i18n/use-translations';
import type { ReminderPromptInfo } from '@kortix/shared';
import { AlarmIcon } from '@phosphor-icons/react';
import { useParams } from 'next/navigation';

/**
 * A reminder fire in the transcript. The platform wrote this prompt, not the
 * person, so it reads as a reminder with its own text rather than as a user
 * bubble carrying the raw `[REMINDER …]` header.
 */
export function ReminderTurnCard({ info }: { info: ReminderPromptInfo }) {
  const t = useTranslations('reminders');
  const params = useParams<{ id?: string; sessionId?: string }>();
  return (
    <div
      className="bg-popover flex max-w-md gap-2 rounded-md border px-4 py-2.5"
      data-testid="reminder-turn"
      data-reminder-id={info.id}
    >
      <AlarmIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium">{t('cardLabel')}</span>
          <Badge variant="muted" size="sm">
            {info.recurring ? t('cardRecurring') : t('cardOneTime')}
          </Badge>
          {params?.id && params.sessionId ? (
            <HoverPrefetchLink
              href={`/projects/${params.id}/reminders?session=${params.sessionId}`}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              {t('cardManage')}
            </HoverPrefetchLink>
          ) : null}
        </div>
        <p className="text-foreground text-sm break-words whitespace-pre-wrap">{info.prompt}</p>
      </div>
    </div>
  );
}
