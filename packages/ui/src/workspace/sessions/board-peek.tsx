'use client';

import { createSessionPrompt, mintWireMessageId, type ProjectSession } from '@kortix/sdk';
import { useSession } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, PaperPlaneRightIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../primitives/sheet';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink } from '../../providers/ui-provider';
import { SessionThread } from '../../session/thread/session-thread';
import { boardAgentLabel, boardStateOf } from './board-grouping';
import { BoardStateMark } from './board-state-mark';

/** A box that answers: its transcript is worth drawing live. Any other session shows its result. */
function isLive(session: ProjectSession, needsYouCount: number): boolean {
  if (session.status !== 'running') return false;
  const state = boardStateOf(session, needsYouCount);
  return state === 'working' || state === 'needs_input' || state === 'idle';
}

/** The live transcript of a running session, read-only: the reply goes through the input below it. */
function PeekThread({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  return <SessionThread session={session} hideHeader readOnly density="compact" className="min-h-0 flex-1" />;
}

/**
 * The board's peek (Claude Code's `Space`): a side sheet with the session's live
 * thread, or its result when its box does not run, and one reply input that
 * steers the running turn. ↑/↓ outside the input move the peek to the next row.
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
  const send = useMutation({
    mutationFn: async ({ sessionId, text }: { sessionId: string; text: string }) => {
      // Minted with no transcript to place it against: the server places it at delivery.
      const messageId = mintWireMessageId();
      return createSessionPrompt(projectId, sessionId, {
        clientMessageId: messageId,
        messageId,
        remintOnDelivery: true,
        // Steer: a running turn reads it at its next step; an idle session starts a turn.
        delivery: 'steer',
        parts: [{ type: 'text', text }],
        clientSentAtMs: Date.now(),
      });
    },
    onSuccess: () => {
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
  const live = session ? isLive(session, needsYouCount) : false;

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
              {live ? (
                <PeekThread key={session.session_id} projectId={projectId} sessionId={session.session_id} />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
                  <p className="text-muted-foreground text-xs">{t('result')}</p>
                  <p className={cn('mt-1 text-sm whitespace-pre-wrap', session.result_excerpt ? 'text-foreground' : 'text-muted-foreground')}>
                    {session.result_excerpt?.trim() || t('noResult')}
                  </p>
                </div>
              )}
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
