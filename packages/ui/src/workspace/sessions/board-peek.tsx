'use client';

import type { ProjectSession } from '@kortix/sdk';
import { ArrowSquareOutIcon, PaperPlaneRightIcon } from '@phosphor-icons/react';
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../primitives/sheet';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink } from '../../providers/ui-provider';
import { SessionPeek } from '../../session/agents/session-peek';
import { useSteerSession } from '../../session/agents/steer-session';
import { boardAgentLabel, boardStateOf } from './board-grouping';
import { BoardStateMark } from './board-state-mark';

/**
 * The board's peek (Claude Code's `Space`): a side sheet with the session's
 * transcript, live, read from the API (`SessionPeek`): a preview wakes no
 * computer and never moves the app's runtime. One reply input steers the
 * running turn. ↑/↓ outside the input move the peek to the next row.
 */
export function BoardPeek({
  projectId,
  session,
  title,
  needsYouCount,
  onClose,
  onMove,
}: {
  projectId: string;
  session: ProjectSession | null;
  title: string;
  needsYouCount: number;
  onClose: () => void;
  onMove: (step: 1 | -1) => void;
}) {
  const t = useTranslations('multiAgent.board');
  const [reply, setReply] = useState('');
  const send = useSteerSession(projectId, {
    onSent: () => {
      setReply('');
      successToast(t('replySent'));
    },
    onError: (error) =>
      errorToast(t('replyFailed'), { description: error instanceof Error ? error.message : undefined }),
  });

  const submit = () => {
    const text = reply.trim();
    if (!session || !text || send.isPending) return;
    send.mutate({ sessionId: session.session_id, text });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.isContentEditable) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      onMove(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const state = session ? boardStateOf(session, needsYouCount) : null;
  const agent = session ? boardAgentLabel(session) : null;

  return (
    <Sheet open={!!session} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-xl"
        overlayClassName="bg-transparent"
        onKeyDown={onKeyDown}
        aria-describedby={undefined}
      >
        {session && state ? (
          <>
            <div className="border-border flex shrink-0 items-start gap-3 border-b px-4 py-3 pr-14">
              <div className="min-w-0 flex-1 space-y-1">
                <SheetTitle className="text-foreground truncate text-sm font-medium">{title}</SheetTitle>
                <SheetDescription asChild>
                  <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                    <BoardStateMark state={state} />
                    {agent ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate">{agent}</span>
                      </>
                    ) : null}
                  </div>
                </SheetDescription>
              </div>
              <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
                <UiLink href={uiRoutes().session(projectId, session.session_id)}>
                  <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                  {t('openSession')}
                </UiLink>
              </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <SessionPeek
                key={session.session_id}
                projectId={projectId}
                sessionId={session.session_id}
                working={state === 'working'}
                density="compact"
              />
            </div>

            <form
              className="border-border flex shrink-0 items-center gap-2 border-t px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <Input
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={t('replyPlaceholder')}
                aria-label={t('replyLabel', { title })}
                disabled={send.isPending}
                className="min-w-0 flex-1"
              />
              <Button type="submit" size="sm" className="shrink-0 gap-1.5" disabled={!reply.trim() || send.isPending}>
                {send.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <PaperPlaneRightIcon className="size-3.5 shrink-0" />
                )}
                {t('sendReply')}
              </Button>
            </form>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
