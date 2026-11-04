'use client';

import { PeerMessageRow } from './peer-message-row';
import type { NoticeBatchItem } from './subagent-notice';
import { SubagentNoticeRow } from './subagent-notice-row';

/**
 * Several notices the API coalesced into one delivered prompt
 * (`session-notice-batch.ts`): background sub-agents that ended, teammates that
 * went idle, sessions that answered a `notify_when_idle`. Each is the row it
 * would be alone, stacked at the rhythm of tool rows: arriving together does
 * not make them a different thing.
 */
export function NoticeBatchGroup({ items, actions }: { items: NoticeBatchItem[]; actions?: React.ReactNode }) {
  return (
    <div data-testid="notice-batch" data-notice-count={items.length} className="flex min-w-0 flex-col gap-1">
      {items.map((item, index) =>
        item.kind === 'peer_idle' ? (
          <PeerMessageRow key={`peer-${item.info.messageId}`} info={{ ...item.info, kind: 'idle_notice' }} />
        ) : (
          <SubagentNoticeRow key={`${item.notice.sessionId}-${index}`} notice={item.notice} />
        ),
      )}
      {actions}
    </div>
  );
}
