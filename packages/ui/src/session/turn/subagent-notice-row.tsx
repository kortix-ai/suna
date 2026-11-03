'use client';

import { useProjectSession } from '@kortix/sdk/react';
import { CaretDownIcon, FileTextIcon } from '@phosphor-icons/react';
import { parseWorkflowResult } from '@kortix/sdk';
import { useState } from 'react';
import { useTranslations } from '../../i18n';
import { useSessionIds } from '../../providers/session-ids';
import { SubagentDialog } from '../agents/subagent-view';
import { cn } from '../../lib/utils';
import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { FinishLine, InlineAction } from '../agents/agent-surface';
import { firstLine, type SubagentNotice } from './subagent-notice';

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


/**
 * A background sub-agent or workflow run this session started has ended, and
 * the API delivered its notice as a prompt (Paper F2-F5). It is an event in the
 * reply above, not a new message, so it draws as one quiet line between two
 * rules: the outcome and a way into the run. The report follows in one card
 * that unfolds in place.
 */
export function SubagentNoticeRow({ notice }: { notice: SubagentNotice }) {
  const t = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const [viewing, setViewing] = useState(false);
  // The name its parent gave it (`agent({ name })`) reads best: "writer finished".
  const child = useProjectSession(ids.projectId, notice.sessionId, { enabled: !!ids.projectId });
  const name = (child.data?.agent_handle || notice.handle || notice.title || notice.agent || t('fallbackName')).replace(WORKFLOW_SUFFIX, '');
  const result = readableReport(notice.result);
  const first = firstLine(result);
  // A first line that only says it is done repeats "finished".
  const excerpt = first && !/^(done|finished|completed?|all done|ok(ay)?)[.!]*$/i.test(first) ? first : undefined;
  const failed = notice.status === 'failed';

  return (
    <div
      data-testid="subagent-notice"
      data-notice-status={notice.status}
      data-child-session={notice.sessionId}
      className="flex min-w-0 flex-col gap-3.5"
    >
      <FinishLine status={NOTICE_GLYPH[notice.status]} tone={failed ? 'failed' : 'default'}>
        <span data-notice-mark={notice.status} className={cn('min-w-0 truncate', !failed && 'text-foreground')} title={name}>
          {t(notice.status, { name })}
        </span>
        <span aria-hidden>·</span>
        <InlineAction onClick={() => setViewing(true)}>{t('viewRun')}</InlineAction>
      </FinishLine>
      {/* The report, in its own card under the line: instant, it is already in the chat. */}
      {result && (
        <Disclosure className="group/notice border-border bg-card overflow-hidden rounded-lg border">
          <DisclosureTrigger>
            <div
              data-testid="notice-result"
              className="hover:bg-muted/40 flex min-w-0 cursor-pointer items-center gap-3 px-3.5 py-2.5 text-sm transition-colors"
            >
              <FileTextIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
              <span className="text-foreground shrink-0 font-medium">{t('result')}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate" title={excerpt}>
                {excerpt}
              </span>
              <CaretDownIcon
                aria-hidden
                className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-(--duration-fast) group-data-[state=open]/notice:rotate-180 motion-reduce:transition-none"
              />
            </div>
          </DisclosureTrigger>
          <DisclosureContent>
            <div className="border-border max-h-96 overflow-y-auto border-t px-3.5 py-3 text-sm">
              <UnifiedMarkdown content={result} trust="agent" isStreaming={false} />
            </div>
          </DisclosureContent>
        </Disclosure>
      )}
      {notice.ownedTasks && (
        <p className="text-muted-foreground min-w-0 truncate text-center text-xs" title={notice.ownedTasks}>
          {t('ownsTasks', { tasks: notice.ownedTasks })}
        </p>
      )}
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={notice.sessionId} title={name} />
    </div>
  );
}
