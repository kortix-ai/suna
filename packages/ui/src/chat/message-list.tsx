'use client';

/**
 * The scrolling transcript of one session: the session log's root thread
 * (`useSessionLogThread`), the optimistic bubble while a send is in flight,
 * open permission and question prompts, and the busy marker. It follows new
 * content while the reader is at the bottom and stays put once they scroll up.
 *
 * Automatic provider-error recovery (KRTX-2597) renders as apps/web renders it:
 * the harness's own `[auto-recovery]` prompt (a synthetic-only user message,
 * `turn.internal`) shows no bubble, a failure the harness continued shows no
 * error row, and the chain's last error row says how many retries ran.
 */

import { SparkleIcon } from '@phosphor-icons/react';
import { type SessionLogMessage, type SessionLogThread, sessionLogTurns } from '@kortix/sdk';
import { type UseSessionResult, useSessionLogThread } from '@kortix/sdk/react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';

import { Bubble, BubbleContent } from '../components/ui/bubble';
import Loading from '../components/ui/loading';
import { Marker, MarkerContent, MarkerIcon } from '../components/ui/marker';
import { Message } from '../components/ui/message';
import { TextShimmer } from '../components/ui/text-shimmer';
import { cn } from '../lib/utils';
import { useUiStrings } from '../providers/ui-provider';
import { type MessageRenderers, MessageView, type RenderTool } from './message-view';
import { type ChatErrorHandler, PermissionPrompt } from './permission-prompt';
import { QuestionPrompt } from './question-prompt';

/** One array for a thread with no messages, so the scroll effect does not run on every render. */
const NO_MESSAGES: SessionLogMessage[] = [];

/** Distance from the bottom, in px, that still counts as "at the bottom". */
const STICK_PX = 80;

/** How the transcript treats each message of an auto-recovery chain, from the SDK turn model. */
export interface AutoRecovery {
  /** User messages that are the harness's own continuation prompt: no bubble. */
  hidden: ReadonlySet<string>;
  /** Assistant messages whose failure the harness continued: no error row. */
  quiet: ReadonlySet<string>;
  /** The last assistant message of a chain that ended in failure → retries before it. */
  retries: ReadonlyMap<string, number>;
}

const NO_RECOVERY: AutoRecovery = { hidden: new Set(), quiet: new Set(), retries: new Map() };

export function autoRecoveryOf(thread: SessionLogThread | null | undefined): AutoRecovery {
  if (!thread?.messages.length) return NO_RECOVERY;
  const hidden = new Set<string>();
  const quiet = new Set<string>();
  const retries = new Map<string, number>();
  for (const turn of sessionLogTurns(thread)) {
    if (turn.internal) hidden.add(turn.user.message_id);
    if (!turn.autoRetry) continue;
    if (turn.autoRetry.continued) for (const a of turn.assistant) quiet.add(a.message_id);
    const last = turn.assistant.at(-1);
    if (!turn.autoRetry.continued && turn.autoRetry.retries > 0 && last) retries.set(last.message_id, turn.autoRetry.retries);
  }
  return hidden.size || quiet.size || retries.size ? { hidden, quiet, retries } : NO_RECOVERY;
}

export function DefaultEmptyState() {
  const t = useUiStrings().chat;
  return (
    <div className="grid place-items-center py-16 text-center">
      <SparkleIcon className="text-muted-foreground size-6" />
      <p className="text-muted-foreground mt-3 text-sm">{t.emptyState}</p>
    </div>
  );
}

export function MessageList({
  session: c,
  emptyState,
  renderTool,
  renderers,
  onError,
  className,
}: {
  session: UseSessionResult;
  /** Shown when the thread has no messages. Defaults to a one-line hint. */
  emptyState?: ReactNode;
  renderTool?: RenderTool;
  renderers?: MessageRenderers;
  onError?: ChatErrorHandler;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const t = useUiStrings().chat;
  const thread = useSessionLogThread(c);
  const messages = thread?.messages ?? NO_MESSAGES;
  const recovery = useMemo(() => autoRecoveryOf(thread), [thread]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages, c.isBusy, c.hasPending, c.pending]);

  return (
    <div
      ref={scrollRef}
      data-slot="message-list"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
      className={cn('scrollbar-thin min-h-0 flex-1 overflow-y-auto', className)}
    >
      <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        {c.isLoading && (
          <div className="text-muted-foreground flex items-center gap-2.5 py-10 text-sm">
            <Loading className="text-muted-foreground size-4" /> {t.loadingConversation}
          </div>
        )}
        {!c.isLoading && messages.length === 0 && !c.hasPending && !c.pending && (emptyState ?? <DefaultEmptyState />)}

        {messages.map((m) =>
          recovery.hidden.has(m.message_id) ? null : (
            <MessageView
              key={m.message_id}
              message={m}
              renderTool={renderTool}
              renderers={renderers}
              hideError={recovery.quiet.has(m.message_id)}
              autoRetries={recovery.retries.get(m.message_id)}
            />
          ),
        )}

        {c.pending && (
          <Message align="end" data-message-role="pending">
            <Bubble align="end" className="opacity-70">
              <BubbleContent>{c.pending}</BubbleContent>
            </Bubble>
          </Message>
        )}

        {c.permissions.map((p) => (
          <PermissionPrompt key={p.id} request={p} onAnswer={c.answerPermission} onError={onError} />
        ))}
        {c.questions.map((q) => (
          <QuestionPrompt key={q.id} request={q} onAnswer={c.answerQuestion} onCancel={c.cancel} onError={onError} />
        ))}

        {c.isBusy && !c.hasPending && (
          <Marker data-slot="busy-marker" className="py-1">
            <MarkerIcon>
              <Loading variant="ring" className="text-muted-foreground" />
            </MarkerIcon>
            <MarkerContent>
              <TextShimmer className="text-sm">{c.pending ? t.sending : t.agentWorking}</TextShimmer>
            </MarkerContent>
          </Marker>
        )}
      </div>
    </div>
  );
}
