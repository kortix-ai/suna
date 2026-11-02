'use client';

import { UsersThreeIcon } from '@phosphor-icons/react';
import { useTranslations } from '../../i18n';
import { PeerMessageRow } from './peer-message-row';
import type { NoticeBatchItem } from './subagent-notice';
import { SubagentNoticeRow } from './subagent-notice-row';

/**
 * Several notices the API coalesced into one delivered prompt
 * (`session-notice-batch.ts`): background subagents that ended, teammates that
 * went idle, sessions that answered a `notify_when_idle`. One header line ("3
 * agents finished") and one compact row each, with no user bubble around them:
 * nobody typed this turn.
 */
export function NoticeBatchGroup({ items, actions }: { items: NoticeBatchItem[]; actions?: React.ReactNode }) {
  const t = useTranslations('multiAgent.notice');
  return (
    <div data-testid="notice-batch" data-notice-count={items.length} className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        <UsersThreeIcon aria-hidden className="size-3.5 shrink-0" />
        <span>{t('batchTitle', { count: items.length })}</span>
      </div>
      <ul className="border-border ml-1.5 flex min-w-0 flex-col gap-1 border-l pl-3">
        {items.map((item, index) => (
          <li key={item.kind === 'peer_idle' ? `peer-${item.info.messageId}` : `${item.notice.sessionId}-${index}`}>
            {item.kind === 'peer_idle' ? <PeerMessageRow info={item.info} /> : <SubagentNoticeRow notice={item.notice} />}
          </li>
        ))}
      </ul>
      {actions}
    </div>
  );
}
