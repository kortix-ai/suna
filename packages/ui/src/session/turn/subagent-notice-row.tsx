'use client';

import { useProjectSession } from '@kortix/sdk/react';
import { parseWorkflowResult } from '@kortix/sdk';
import { useState } from 'react';
import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { useSessionIds } from '../../providers/session-ids';
import { SubagentDialog } from '../agents/subagent-view';
import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { AgentFace, AgentFailure, AgentRowBody, AgentRowScope, AgentStatus, AgentTrigger, OpenAgentButton } from '../agents/agent-surface';
import { BasicTool } from '../tool/shared/infrastructure';
import { firstLine, type SubagentNotice } from './subagent-notice';

/** A workflow's report arrives wrapped in `<workflow_result>`: the person reads what is inside. */
const RESULT_TAG = /<\/?workflow_?result>/gi;

export function readableReport(text: string): string {
  return (parseWorkflowResult(text)?.text ?? text).replace(RESULT_TAG, '').trim();
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
 *   [face] pricing-scout  Three of five competitors raised prices…   ✓ Finished
 *          │ the whole report (Markdown)
 *          │ Open ↗
 *
 * A failure says so in one sentence; the platform's raw text folds behind "Details".
 */
export function SubagentNoticeRow({ notice, defaultOpen }: { notice: SubagentNotice; defaultOpen?: boolean }) {
  const t = useTranslations('multiAgent.notice');
  const tAgent = useTranslations('tools.agent');
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
          defaultOpen={defaultOpen}
        >
          <AgentRowBody>
            {failed ? (
              <AgentFailure sentence={t('failedSentence')} raw={result} />
            ) : (
              result && (
                <div data-testid="notice-result" className="max-h-96 min-w-0 overflow-y-auto">
                  <UnifiedMarkdown content={result} trust="agent" isStreaming={false} />
                </div>
              )
            )}
            <OpenAgentButton label={tAgent('openAgent', { name })} onClick={() => setViewing(true)} />
          </AgentRowBody>
        </BasicTool>
      </AgentRowScope>
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={notice.sessionId} title={name} />
    </div>
  );
}
