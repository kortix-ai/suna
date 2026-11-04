'use client';

/**
 * The asks deck: everything an agent waits on a person for, one card at a time.
 *
 * An ask never holds its session (the runtime parks it), so this deck is the
 * one place a person catches up: agent questions, tool calls the permission
 * policy sent to them, connector calls that wait for approval, across every
 * session they may decide. Each card shows what is asked, who asked and the
 * exact command or call. Yes / No decide it, Skip moves it to the back.
 *
 * Keyboard: → or Y yes, ← or N no, S skip (the inbox list below owns j/k,
 * the arrows up and down, and 1–3). Touch:
 * swipe right yes, left no. A decision waits `UNDO_MS` before it is sent, so
 * Undo takes it back; leaving the page sends what waits.
 */

import { resolveApproval, type SessionAsk } from '@kortix/sdk';
import { qk, useAnswerSessionAsk, useSessionAsks } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpIcon, CheckIcon, ShieldWarningIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { Kbd } from '../../primitives/kbd';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, undoToast } from '../../primitives/toast';
import type { PermissionRequest, QuestionRequest } from '../../internal/session-types';
import { COMPOSER_INPUT_SLOT_CLASS } from '../../session/composer/composer';
import { QuestionPrompt, type QuestionAction, type QuestionPromptHandle } from '../../session/prompts/question-prompt';
import { SessionPermissionPrompt } from '../../session/prompts/session-permission-prompt';

/** How long a decision waits for Undo before it is sent. */
const UNDO_MS = 5_000;
/** How far a card moves before a swipe decides it. */
const SWIPE_PX = 96;

type Verdict = 'yes' | 'no' | 'always';

interface Staged {
  ask: SessionAsk;
  verdict: Verdict;
  answers?: string[][];
  timer: ReturnType<typeof setTimeout>;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** The deck's order: oldest first, skipped asks after the rest. Pure; exported for tests. */
export function deckOrder(asks: readonly SessionAsk[], skipped: readonly string[], hidden: ReadonlySet<string>): SessionAsk[] {
  const open = asks.filter((ask) => !hidden.has(ask.id));
  const rank = new Map(skipped.map((id, i) => [id, i]));
  return [...open].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined || rb !== undefined) return (ra ?? -1) - (rb ?? -1);
    return a.asked_at < b.asked_at ? -1 : a.asked_at > b.asked_at ? 1 : 0;
  });
}

export function AskDeck({ projectId, onOpenSession }: { projectId: string; onOpenSession?: (sessionId: string) => void }) {
  const t = useTranslations('hardcodedUi.askDeck');
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useSessionAsks(projectId);
  const answer = useAnswerSessionAsk(projectId);
  const [skipped, setSkipped] = useState<string[]>([]);
  const staged = useRef(new Map<string, Staged>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  // Connector approvals keep the full parameter review in the inbox list below.
  const deck = useMemo(
    () => deckOrder((data?.asks ?? []).filter((ask) => ask.kind !== 'approval'), skipped, hidden),
    [data, skipped, hidden],
  );
  const current = deck[0] ?? null;

  const send = useCallback(
    async (entry: Staged) => {
      staged.current.delete(entry.ask.id);
      try {
        if (entry.ask.kind === 'approval') {
          await resolveApproval(projectId, entry.ask.request_id, entry.verdict === 'no' ? 'deny' : 'approve');
          await queryClient.invalidateQueries({ queryKey: qk.project.asks(projectId) });
          await queryClient.invalidateQueries({ queryKey: qk.project.reviewItemsScope(projectId) });
        } else if (entry.ask.kind === 'question') {
          await answer.mutateAsync({
            askId: entry.ask.id,
            answer: entry.verdict === 'no' || !entry.answers ? { dismiss: true } : { answers: entry.answers },
          });
        } else {
          await answer.mutateAsync({
            askId: entry.ask.id,
            answer: { reply: entry.verdict === 'no' ? 'reject' : entry.verdict === 'always' ? 'always' : 'once' },
          });
        }
      } catch (err) {
        errorToast(err instanceof Error ? err.message : t('failed'));
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(entry.ask.id);
          return next;
        });
      }
    },
    [answer, projectId, queryClient, t],
  );

  // The latest `send`, for timers and the unmount flush: `send` changes every
  // render (the mutation object does), and an effect keyed on it would flush
  // every staged decision on the next render, before its Undo window.
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });

  // Leaving the deck sends every decision that still waits for its Undo window.
  useEffect(() => {
    const pending = staged.current;
    return () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        void sendRef.current(entry);
      }
    };
  }, []);

  const decide = useCallback(
    (ask: SessionAsk, verdict: Verdict, answers?: string[][]) => {
      setHidden((prev) => new Set(prev).add(ask.id));
      const entry: Staged = { ask, verdict, answers, timer: setTimeout(() => void sendRef.current(entry), UNDO_MS) };
      staged.current.set(ask.id, entry);
      const message = verdict === 'no' ? t(ask.kind === 'question' ? 'dismissed' : 'denied') : t(ask.kind === 'question' ? 'answered' : 'approved');
      undoToast(message, {
        duration: UNDO_MS,
        undoLabel: t('undo'),
        onUndo: () => {
          const waiting = staged.current.get(ask.id);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          staged.current.delete(ask.id);
          setHidden((prev) => {
            const next = new Set(prev);
            next.delete(ask.id);
            return next;
          });
        },
      });
    },
    [t],
  );

  const skip = useCallback((ask: SessionAsk) => setSkipped((prev) => [...prev.filter((id) => id !== ask.id), ask.id]), []);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (isError) {
    return (
      <EmptyState
        icon={ShieldWarningIcon}
        title={t('loadFailed')}
        action={
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  }
  if (!current) {
    return <EmptyState icon={CheckIcon} title={t('emptyTitle')} description={t('emptyDescription')} />;
  }
  return (
    <section aria-label={t('label')} className="flex w-full flex-col gap-3">
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>{t('remaining', { count: deck.length })}</span>
        <span className="hidden items-center gap-2 sm:flex">
          <Kbd>←</Kbd> {t('no')} <Kbd>→</Kbd> {t('yes')} <Kbd>S</Kbd> {t('skip')}
        </span>
      </div>
      <AskCard
        key={current.id}
        ask={current}
        onDecide={(verdict, answers) => decide(current, verdict, answers)}
        onSkip={() => skip(current)}
        onOpenSession={onOpenSession}
      />
    </section>
  );
}

/**
 * One ask, drawn exactly as the session draws it: the docked strip holds the
 * session's own `QuestionPrompt` or `SessionPermissionPrompt`, and the card
 * under it is the composer's answer line (`composer.tsx` / `ComposerCard`).
 * Only the context row (where it was asked, Skip) is the deck's own.
 */
function AskCard({
  ask,
  onDecide,
  onSkip,
  onOpenSession,
}: {
  ask: SessionAsk;
  onDecide: (verdict: Verdict, answers?: string[][]) => void;
  onSkip: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const t = useTranslations('hardcodedUi.askDeck');
  const tCommon = useTranslations('common');
  const promptRef = useRef<QuestionPromptHandle>(null);
  const [typed, setTyped] = useState('');
  const [action, setAction] = useState<{ action: QuestionAction; canAct: boolean }>({ action: 'send', canAct: true });
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  // Stable, and a no-op when nothing changed: `QuestionPrompt` reports from an effect keyed on it.
  const onActionChange = useCallback((next: QuestionAction, canAct: boolean) => {
    setAction((prev) => (prev.action === next && prev.canAct === canAct ? prev : { action: next, canAct }));
  }, []);

  const question = useMemo<QuestionRequest | null>(
    () =>
      ask.kind === 'question' && ask.question
        ? { id: ask.request_id, sessionID: ask.session_id, questions: ask.question.questions as QuestionRequest['questions'] }
        : null,
    [ask],
  );
  const permission = useMemo<PermissionRequest | null>(
    () =>
      ask.kind === 'permission' && ask.permission
        ? {
            id: ask.request_id,
            sessionID: ask.session_id,
            permission: ask.permission.permission,
            patterns: ask.permission.patterns,
            metadata: ask.permission.args && typeof ask.permission.args === 'object' ? (ask.permission.args as Record<string, unknown>) : {},
            always: ['*'],
          }
        : null,
    [ask],
  );

  // The composer's send button, as the session wires it: typed text is an
  // answer; with nothing typed it steps the question (Next) or submits it.
  const canSend = question ? typed.trim().length > 0 || (action.action !== 'send' && action.canAct) : false;
  const send = useCallback(() => {
    const prompt = promptRef.current;
    if (!prompt) return;
    if (typed.trim()) {
      if (!prompt.acceptsCustom) return;
      prompt.submitCustomAnswer(typed);
      setTyped('');
      return;
    }
    if (prompt.canAct) prompt.performAction();
  }, [typed]);

  const yes = useCallback(() => {
    if (permission) onDecide('yes');
    else if (canSend) send();
  }, [permission, onDecide, canSend, send]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === 'arrowright' || key === 'y') yes();
      else if (key === 'arrowleft' || key === 'n') onDecide('no');
      else if (key === 's') onSkip();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [yes, onDecide, onSkip]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') dragStart.current = event.clientX;
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (dragStart.current !== null) setDrag(event.clientX - dragStart.current);
  };
  const onPointerUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > SWIPE_PX) yes();
    else if (drag < -SWIPE_PX) onDecide('no');
    setDrag(0);
  };

  const fromWorker = ask.session_id !== ask.surface_session_id;
  const sendLabel = action.action === 'next' ? tCommon('next') : t('send');

  return (
    <article
      className="flex w-full touch-pan-y flex-col transition-transform duration-fast ease-out"
      style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragStart.current = null;
        setDrag(0);
      }}
    >
      {/* The docked strip, as above the session composer. */}
      <div className={cn(COMPOSER_INPUT_SLOT_CLASS, 'bg-background ring-muted/15 ring-3 [clip-path:inset(-8px_-8px_0_-8px)]')}>
        {question ? (
          <QuestionPrompt
            key={question.id}
            ref={promptRef}
            request={question}
            onReply={(_id, answers) => onDecide('yes', answers)}
            onReject={() => onDecide('no')}
            onActionChange={onActionChange}
          />
        ) : permission ? (
          <SessionPermissionPrompt
            sessionId={ask.session_id}
            permissions={[permission]}
            sessionControls={false}
            onReply={async (_id, reply) => onDecide(reply === 'reject' ? 'no' : reply === 'always' ? 'always' : 'yes')}
          />
        ) : null}
      </div>
      {/* The composer card under it: the answer line for a question, where it was asked for both. */}
      <div className="bg-background border-border ring-muted/15 ring-3 [clip-path:inset(0_-8px_-8px_-8px)] flex w-full flex-col rounded-b-xl border">
        {question ? (
          <div className="flex items-end gap-2 px-3 pt-3 pb-2">
            <textarea
              rows={1}
              value={typed}
              placeholder={t('typeAnswer')}
              aria-label={t('typeAnswer')}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className="text-foreground placeholder:text-muted-foreground max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 outline-none"
            />
            <Button
              size="sm"
              disabled={!canSend}
              onClick={send}
              aria-label={sendLabel}
              className="shrink-0 rounded-full"
            >
              {action.action === 'next' && !typed.trim() ? sendLabel : <ArrowUpIcon weight="bold" className="size-3.5" />}
            </Button>
          </div>
        ) : null}
        <div className={cn('text-muted-foreground flex items-center gap-2 px-3 pb-2 text-xs', !question && 'pt-2')}>
          {ask.session_title ? (
            <button
              type="button"
              className="hover:text-foreground min-w-0 truncate underline-offset-2 hover:underline"
              onClick={() => onOpenSession?.(ask.surface_session_id)}
            >
              {ask.session_title}
            </button>
          ) : null}
          <span className="shrink-0">{t('askedAgo', { time: relativeTime(ask.asked_at) })}</span>
          {fromWorker ? <span className="shrink-0">· {t('fromWorker')}</span> : null}
          <Button size="xs" variant="ghost" className="text-muted-foreground ml-auto" onClick={onSkip}>
            {t('skip')}
            <Kbd className="ml-1">S</Kbd>
          </Button>
        </div>
      </div>
    </article>
  );
}
