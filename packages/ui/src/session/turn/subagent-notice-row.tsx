'use client';

import { useProjectSession } from '@kortix/sdk/react';
import { workflowResultMarkdown } from '../tool/tools/workflow-result-text';
import { useState } from 'react';
import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { useSessionIds } from '../../providers/session-ids';
import { SubagentDialog } from '../agents/subagent-view';
import { AgentFace, AgentRowScope, AgentStatus, AgentTrigger } from '../agents/agent-surface';
import { BasicTool } from '../tool/shared/infrastructure';
import { firstLine, type SubagentNotice } from './subagent-notice';

/** A workflow's report arrives wrapped in `<workflow_result>`: the person reads what is inside. */
const RESULT_TAG = /<\/?workflow_?result>/gi;

export function readableReport(text: string): string {
  // A JSON result reads as its document (a JSON object of prose), never as the JSON source.
  return workflowResultMarkdown(text).replace(RESULT_TAG, '').trim();
}

/** A run's own name carries " (workflow)"; the line names the run, the glyph says what it is. */
export const WORKFLOW_SUFFIX = /\s*\(workflow\)\s*$/i;

export const NOTICE_GLYPH: Record<SubagentNotice['status'], 'done' | 'failed' | 'stopped'> = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** A first line that only says it is done repeats the state word. */
const ONLY_DONE = /^(done|finished|completed?|all done|ok(ay)?)[.!]*$/i;

/** Who the notice is from: the handle its parent gave it, else the kind of agent, else the task. */
function useNoticeName(notice: SubagentNotice): { name: string; face: string } {
  const t = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const child = useProjectSession(ids.projectId, notice.sessionId, { enabled: !!ids.projectId });
  const handle = child.data?.agent_handle?.trim() || notice.handle;
  const name = (handle || (notice.agent ? agentDisplayName(notice.agent) : '') || notice.title || t('fallbackName')).replace(WORKFLOW_SUFFIX, '');
  return { name, face: handle || notice.agent || 'general' };
}

/**
 * A background sub-agent or workflow run this session started has ended, and
 * the API delivered its notice as a prompt. Nobody typed it, so it is never a
 * bubble: it is one agent row, the same row as the call that started it.
 *
 *   [face] pricing-scout  Three of five competitors raised prices…   ✓ Finished  >
 *
 * A click opens the agent's session beside the chat, in the side panel, where its
 * report is the last reply; without a panel, in the agent dialog.
 */
export function SubagentNoticeRow({ notice }: { notice: SubagentNotice; defaultOpen?: boolean }) {
  const t = useTranslations('multiAgent.notice');
  const { name, face } = useNoticeName(notice);
  const [viewing, setViewing] = useState(false);
  const failed = notice.status === 'failed';
  const result = readableReport(notice.result);
  const first = firstLine(result);
  const subtitle = notice.ownedTasks
    ? t('ownsTasks', { tasks: notice.ownedTasks })
    : failed
      ? (notice.title ?? undefined)
      : first && !ONLY_DONE.test(first)
        ? first
        : (notice.title ?? undefined);

  return (
    <div data-testid="subagent-notice" data-notice-status={notice.status} data-child-session={notice.sessionId} className="min-w-0">
      <AgentRowScope>
        <BasicTool
          icon={<AgentFace handle={face} />}
          trigger={<AgentTrigger title={name} subtitle={subtitle} />}
          triggerAction={<AgentStatus status={NOTICE_GLYPH[notice.status]} label={t(`state.${notice.status}`)} opens />}
          onClick={() => setViewing(true)}
        />
      </AgentRowScope>
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={notice.sessionId} title={name} handle={face} task={subtitle} failure={failed ? result || t('failedSentence') : undefined} />
    </div>
  );
}
