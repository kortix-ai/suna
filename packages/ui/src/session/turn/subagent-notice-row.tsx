'use client';

import { useProjectSession } from '@kortix/sdk/react';
import { CheckIcon, StopCircleIcon, WarningIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { useTranslations } from '../../i18n';
import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { useSessionIds } from '../../providers/session-ids';
import { SubagentDialog } from '../agents/subagent-view';
import { FullViewAction } from '../tool/shared/full-view-action';
import { BasicTool } from '../tool/shared/infrastructure';
import { ToolResultCard } from '../tool/shared/result-card';
import type { SubagentNotice } from './subagent-notice';

/**
 * A background subagent (or a background workflow run) this session started
 * has ended, or a teammate of its agent team went idle, and the API delivered
 * its notice as a prompt. It is not something the person typed, and its report
 * is often long, so it draws as one tool row, the same row as the "Agent ·
 * general" card that started it: "✓ post writer finished · <first line of the
 * result>   View". The row opens in place to the whole result; "View" opens the
 * child's own session.
 *
 * The state is a glyph, as on every tool row, never an emoji: emoji status
 * labels are the agent's own words (brand D31, D32), and the reply right under
 * this row often starts with one.
 */
// `data-tone` keeps the hue: the tool row header paints any other leading glyph muted.
const MARK: Record<SubagentNotice['status'], ReactNode> = {
  completed: <CheckIcon data-notice-mark="completed" data-tone="success" aria-hidden weight="bold" className="text-kortix-green size-3.5 shrink-0" />,
  failed: <WarningIcon data-notice-mark="failed" data-tone="destructive" aria-hidden weight="fill" className="text-kortix-red size-3.5 shrink-0" />,
  stopped: <StopCircleIcon data-notice-mark="stopped" aria-hidden className="size-3.5 shrink-0" />,
};

/** A first line that only says the work is done repeats "finished". */
const FILLER_EXCERPT = /^(done|finished|completed?|all done|ok(ay)?)[.!]*$/i;

export function SubagentNoticeRow({ notice }: { notice: SubagentNotice }) {
  const t = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const [viewing, setViewing] = useState(false);
  // The name its parent gave it (`agent({ name })`) reads best: "writer finished".
  const child = useProjectSession(ids.projectId, notice.sessionId, { enabled: !!ids.projectId });
  const name = child.data?.agent_handle || notice.handle || notice.title || notice.agent || t('fallbackName');
  const excerpt = notice.excerpt && !FILLER_EXCERPT.test(notice.excerpt.trim()) ? notice.excerpt : undefined;
  const expandable = notice.result.trim().length > 0 && notice.result.trim() !== notice.excerpt;
  const openSession = () => setViewing(true);
  return (
    <div
      data-testid="subagent-notice"
      data-notice-status={notice.status}
      data-child-session={notice.sessionId}
      className="flex min-w-0 flex-col"
    >
      <BasicTool
        icon={MARK[notice.status]}
        trigger={{ title: t(notice.status, { name }), subtitle: excerpt }}
        triggerAction={<FullViewAction onOpen={openSession} />}
        // Nothing to unfold: the row is a plain way into the child's session.
        onClick={expandable ? undefined : openSession}
      >
        {expandable ? (
          // The report is the child's output, framed like every tool result, so
          // it never reads as a second reply from this session's agent.
          <ToolResultCard bodyClassName="max-h-96 overflow-y-auto px-3 py-2 text-sm">
            <UnifiedMarkdown content={notice.result} trust="agent" isStreaming={false} />
          </ToolResultCard>
        ) : undefined}
      </BasicTool>
      {notice.ownedTasks && (
        <p className="text-muted-foreground ml-6 min-w-0 truncate text-xs" title={notice.ownedTasks}>
          {t('ownsTasks', { tasks: notice.ownedTasks })}
        </p>
      )}
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={notice.sessionId} title={name} />
    </div>
  );
}
