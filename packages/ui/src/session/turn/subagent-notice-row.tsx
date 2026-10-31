'use client';

import { useProjectSession } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, CaretRightIcon, StopCircleIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { Button } from '../../primitives/button';
import { Hint } from '../../primitives/hint';
import { useSessionIds } from '../../providers/session-ids';
import { SubagentDialog } from '../agents/subagent-view';
import type { SubagentNotice } from './subagent-notice';

/**
 * A background subagent (or a background workflow run) this session started
 * has ended, or a teammate of its agent team went idle, and the API delivered its notice as a prompt. It is not something
 * the person typed, and its report is often long, so it draws as one compact
 * row: "✅ post writer finished · <first line of the result>". The row opens in
 * place to the whole result; "Open session" opens the child's own session.
 *
 * The status emoji is a label (brand D31: ✅ done, ⚠️ a problem). A stop is
 * not a problem, so it takes a neutral glyph instead.
 */
export function SubagentNoticeRow({ notice }: { notice: SubagentNotice }) {
  const t = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  const bodyId = useId();
  // The name its parent gave it (`agent({ name })`) reads best: "writer finished".
  const child = useProjectSession(ids.projectId, notice.sessionId, { enabled: !!ids.projectId });
  const name = child.data?.agent_handle || notice.handle || notice.title || notice.agent || t('fallbackName');
  const headline = t(notice.status, { name });
  const expandable = notice.result.trim().length > 0 && notice.result.trim() !== notice.excerpt;
  const mark =
    notice.status === 'completed' ? (
      <span aria-hidden className="shrink-0">
        ✅
      </span>
    ) : notice.status === 'failed' ? (
      <span aria-hidden className="shrink-0">
        ⚠️
      </span>
    ) : (
      <StopCircleIcon aria-hidden className="size-3.5 shrink-0" />
    );
  const line = (
    <>
      {mark}
      <span className="text-foreground shrink-0 font-medium">{headline}</span>
      {notice.excerpt && (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="min-w-0 truncate" title={notice.excerpt}>
            {notice.excerpt}
          </span>
        </>
      )}
    </>
  );
  return (
    <div
      data-testid="subagent-notice"
      data-notice-status={notice.status}
      data-child-session={notice.sessionId}
      className="flex min-w-0 flex-col gap-1"
    >
      <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((value) => !value)}
            className="hover:text-foreground duration-fast flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors"
          >
            {line}
            <CaretRightIcon aria-hidden className={cn('size-3 shrink-0', open && 'rotate-90')} />
            <span className="sr-only">{open ? t('collapse') : t('expand')}</span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">{line}</div>
        )}
        <Hint label={t('openSession')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('openSession')}
            onClick={() => setViewing(true)}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      </div>
      {notice.ownedTasks && (
        <p className="text-muted-foreground ml-5 min-w-0 truncate text-xs" title={notice.ownedTasks}>
          {t('ownsTasks', { tasks: notice.ownedTasks })}
        </p>
      )}
      {expandable && open && (
        <div id={bodyId} className="text-muted-foreground border-border ml-1.5 border-l pl-3 text-sm">
          <UnifiedMarkdown content={notice.result} trust="agent" isStreaming={false} />
        </div>
      )}
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={notice.sessionId} title={name} />
    </div>
  );
}
