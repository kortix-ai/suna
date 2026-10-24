'use client';

import type { ChangeRequest } from '@kortix/sdk';
import { ArrowBendUpLeftIcon } from '@phosphor-icons/react';
import { useLocale, useTranslations } from '../../../i18n';
import { relativeTime } from '../../../internal/lib/relative-time';
import { ChangeRequestStatusBadge } from '../../../files/project/components/change-request-status-badge';
import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import Hint from '../../../primitives/hint';
import { PanelCard } from './panel-card';

export function ChangeRequestsCard({ requests, onOpen, onJump, jumping = false }: {
  requests: ChangeRequest[];
  onOpen: (crId: string) => void;
  onJump: (crId: string) => Promise<void>;
  jumping?: boolean;
}) {
  const t = useTranslations('sessionChangeRequests');
  const locale = useLocale();
  if (requests.length === 0) return null;

  return (
    <PanelCard title={t('title')} count={requests.length} isEmpty={false} defaultExpanded
      fill contentClassName="min-h-0 overflow-y-auto px-2 py-2">
      <ul>
        {[...requests].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((cr) => (
          <li key={cr.cr_id} className="flex items-center gap-1">
            <button type="button" data-cr-id={cr.cr_id} onClick={() => onOpen(cr.cr_id)}
              className="hover:bg-accent flex min-w-0 flex-1 flex-col gap-1 rounded-sm px-2 py-2 text-left">
              <span className="flex w-full min-w-0 items-baseline gap-2">
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">#{cr.number}</span>
                <span className="text-foreground truncate text-sm">{cr.title}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {cr.status === 'open' ? <Badge variant="secondary" size="sm">{t('open')}</Badge> : <ChangeRequestStatusBadge cr={cr} />}
                <time dateTime={cr.created_at} className="text-muted-foreground text-xs">{relativeTime(cr.created_at, locale)}</time>
              </span>
            </button>
            <Hint label={t('jump', { number: cr.number })}>
              <Button variant="ghost" size="icon" disabled={jumping} aria-label={t('jump', { number: cr.number })}
                onClick={() => onJump(cr.cr_id)}>
                <ArrowBendUpLeftIcon className="size-3.5 shrink-0" />
              </Button>
            </Hint>
          </li>
        ))}
      </ul>
    </PanelCard>
  );
}
