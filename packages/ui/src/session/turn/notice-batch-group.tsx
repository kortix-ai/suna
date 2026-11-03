'use client';

import { useProjectSession } from '@kortix/sdk/react';
import { useState } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { useSessionIds } from '../../providers/session-ids';
import { AgentCard, AgentGlyph, FinishLine } from '../agents/agent-surface';
import { SubagentDialog } from '../agents/subagent-view';
import { peerHandleLabel } from '@kortix/shared';
import { peerMessagePreview } from './peer-message-row';
import { firstLine, type NoticeBatchItem, type SubagentNotice } from './subagent-notice';
import { NOTICE_GLYPH, readableReport, WORKFLOW_SUFFIX } from './subagent-notice-row';

/**
 * Several notices the API coalesced into one delivered prompt
 * (`session-notice-batch.ts`): background sub-agents that ended, teammates that
 * went idle, sessions that answered a `notify_when_idle`. Like one notice, it is
 * an event in the reply above: one finish line ("3 agents finished"), then one
 * card with a row per agent. A row opens that agent beside the chat.
 */
export function NoticeBatchGroup({ items, actions }: { items: NoticeBatchItem[]; actions?: React.ReactNode }) {
  const t = useTranslations('multiAgent.notice');
  const failed = items.some((item) => item.kind !== 'peer_idle' && item.notice.status === 'failed');
  return (
    <div data-testid="notice-batch" data-notice-count={items.length} className="flex min-w-0 flex-col gap-3.5">
      <FinishLine status={failed ? 'failed' : 'done'} tone={failed ? 'failed' : 'default'}>
        <span className={cn(!failed && 'text-foreground')}>{t('batchTitle', { count: items.length })}</span>
      </FinishLine>
      <AgentCard testId="notice-batch-card" className="py-1.5">
        <ul className="flex min-w-0 flex-col px-1.5">
          {items.map((item, index) => (
            <li key={item.kind === 'peer_idle' ? `peer-${item.info.messageId}` : `${item.notice.sessionId}-${index}`}>
              {item.kind === 'peer_idle' ? (
                <BatchRow
                  status="done"
                  name={t('peerFinished', { name: peerHandleLabel(item.info.from) })}
                  line={peerMessagePreview({ ...item.info, kind: 'idle_notice' })}
                />
              ) : (
                <NoticeBatchRow notice={item.notice} />
              )}
            </li>
          ))}
        </ul>
      </AgentCard>
      {actions}
    </div>
  );
}

function NoticeBatchRow({ notice }: { notice: SubagentNotice }) {
  const t = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const [viewing, setViewing] = useState(false);
  const child = useProjectSession(ids.projectId, notice.sessionId, { enabled: !!ids.projectId });
  const name = (child.data?.agent_handle || notice.handle || notice.title || notice.agent || t('fallbackName')).replace(WORKFLOW_SUFFIX, '');
  return (
    <>
      <BatchRow
        status={NOTICE_GLYPH[notice.status]}
        name={t(notice.status, { name })}
        // A teammate that still owns tasks says so: that matters more than its first line.
        line={notice.ownedTasks ? t('ownsTasks', { tasks: notice.ownedTasks }) : firstLine(readableReport(notice.result))}
        failed={notice.status === 'failed'}
        onOpen={() => setViewing(true)}
      />
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={notice.sessionId} title={name} />
    </>
  );
}

function BatchRow({
  status,
  name,
  line,
  failed = false,
  onOpen,
}: {
  status: 'done' | 'failed' | 'stopped';
  name: string;
  line?: string;
  failed?: boolean;
  onOpen?: () => void;
}) {
  const t = useTranslations('multiAgent.notice');
  const body = (
    <>
      <AgentGlyph status={status} />
      <span className={cn('min-w-0 shrink-0 truncate font-medium', failed ? 'text-kortix-red' : 'text-foreground')}>{name}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate" title={line}>
        {line}
      </span>
      {onOpen && <span className="text-foreground shrink-0 text-xs">{t('viewRun')}</span>}
    </>
  );
  const rowClass = 'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm';
  return onOpen ? (
    <button type="button" data-batch-row onClick={onOpen} className={cn(rowClass, 'hover:bg-muted/40 cursor-pointer')}>
      {body}
    </button>
  ) : (
    <div data-batch-row className={rowClass}>
      {body}
    </div>
  );
}
