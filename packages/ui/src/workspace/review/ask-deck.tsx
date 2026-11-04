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
import { CheckIcon, ChatCircleDotsIcon, PlugIcon, ShieldWarningIcon, XIcon, ArrowDownIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { Kbd } from '../../primitives/kbd';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, undoToast } from '../../primitives/toast';

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

/** The answers a question card sends: the picked labels, else the typed text. Null until every question has one. */
export function questionAnswers(
  questions: NonNullable<SessionAsk['question']>['questions'],
  picked: Record<number, string[]>,
  typed: Record<number, string>,
): string[][] | null {
  const answers = questions.map((_, i) => {
    const text = typed[i]?.trim();
    return text ? [...(picked[i] ?? []), text] : (picked[i] ?? []);
  });
  return answers.every((a) => a.length > 0) ? answers : null;
}

export function AskDeck({ projectId, onOpenSession }: { projectId: string; onOpenSession?: (sessionId: string) => void }) {
  const t = useTranslations('hardcodedUi.askDeck');
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useSessionAsks(projectId);
  const answer = useAnswerSessionAsk(projectId);
  const [skipped, setSkipped] = useState<string[]>([]);
  const staged = useRef(new Map<string, Staged>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const deck = useMemo(() => deckOrder(data?.asks ?? [], skipped, hidden), [data, skipped, hidden]);
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
  sendRef.current = send;

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

const KIND_ICON = { question: ChatCircleDotsIcon, permission: ShieldWarningIcon, approval: PlugIcon } as const;

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
  const questions = ask.question?.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  const answers = ask.kind === 'question' ? questionAnswers(questions, picked, typed) : null;
  const canYes = ask.kind !== 'question' || answers !== null;
  const Icon = KIND_ICON[ask.kind];

  const yes = useCallback(() => {
    if (!canYes) return;
    onDecide('yes', answers ?? undefined);
  }, [canYes, onDecide, answers]);

  const pick = useCallback(
    (qi: number, label: string) => {
      const q = questions[qi];
      if (!q) return;
      if (q.multiple) {
        setPicked((prev) => {
          const now = prev[qi] ?? [];
          return { ...prev, [qi]: now.includes(label) ? now.filter((l) => l !== label) : [...now, label] };
        });
        return;
      }
      // One question with one choice: picking it is the answer.
      if (questions.length === 1 && !typed[0]?.trim()) {
        onDecide('yes', [[label]]);
        return;
      }
      setPicked((prev) => ({ ...prev, [qi]: [label] }));
    },
    [questions, typed, onDecide],
  );

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
    if (event.pointerType !== 'touch') return;
    dragStart.current = event.clientX;
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (dragStart.current !== null) setDrag(event.clientX - dragStart.current);
  };
  const onPointerUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > SWIPE_PX && canYes) yes();
    else if (drag < -SWIPE_PX) onDecide('no');
    setDrag(0);
  };

  const subject = ask.permission?.patterns.find((p) => p && p !== '*');
  const fromWorker = ask.session_id !== ask.surface_session_id;

  return (
    <article
      className="bg-card border-border flex touch-pan-y flex-col gap-4 rounded-lg border p-5 shadow-xs transition-transform duration-fast ease-out"
      style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragStart.current = null;
        setDrag(0);
      }}
    >
      <header className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="sm">
              {t(`kind.${ask.kind}`)}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {t('askedAgo', { time: relativeTime(ask.asked_at) })}
              {fromWorker ? ` · ${t('fromWorker')}` : ''}
            </span>
          </div>
          <h3 className="text-foreground mt-1.5 text-sm font-medium break-words">
            {ask.kind === 'question' ? (questions[0]?.question ?? ask.title) : ask.kind === 'permission' ? t('permissionTitle', { tool: ask.permission?.tool ?? '' }) : t('approvalTitle')}
          </h3>
          {ask.session_title ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground mt-0.5 truncate text-xs underline-offset-2 hover:underline"
              onClick={() => onOpenSession?.(ask.surface_session_id)}
            >
              {t('inSession', { title: ask.session_title })}
            </button>
          ) : null}
        </div>
      </header>

      {ask.kind === 'permission' ? (
        <pre className="bg-muted text-foreground max-h-48 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-all">
          {subject ?? ask.title}
        </pre>
      ) : null}
      {ask.kind === 'approval' ? (
        <pre className="bg-muted text-foreground overflow-auto rounded-md p-3 font-mono text-xs break-all">{ask.approval?.action ?? ask.title}</pre>
      ) : null}
      {ask.kind === 'question'
        ? questions.map((q, qi) => (
            <div key={qi} className="flex flex-col gap-2">
              {qi > 0 || questions.length > 1 ? <p className="text-foreground text-sm">{q.question}</p> : null}
              <div className="flex flex-wrap gap-2">
                {q.options.map((option) => {
                  const on = picked[qi]?.includes(option.label) ?? false;
                  return (
                    <Button
                      key={option.label}
                      size="sm"
                      variant={on ? 'default' : 'outline'}
                      title={option.description || undefined}
                      onClick={() => pick(qi, option.label)}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              {q.custom !== false ? (
                <input
                  className="border-border bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-8 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
                  placeholder={t('typeAnswer')}
                  value={typed[qi] ?? ''}
                  onChange={(event) => setTyped((prev) => ({ ...prev, [qi]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      yes();
                    }
                  }}
                />
              ) : null}
            </div>
          ))
        : null}

      <footer className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => onDecide('no')}>
          <XIcon className="size-3.5" />
          {ask.kind === 'question' ? t('dismiss') : t('deny')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onSkip}>
          <ArrowDownIcon className="size-3.5" />
          {t('skip')}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {ask.kind === 'permission' ? (
            <Button size="sm" variant="outline" onClick={() => onDecide('always')}>
              {t('allowSession', { tool: ask.permission?.tool ?? '' })}
            </Button>
          ) : null}
          <Button size="sm" disabled={!canYes} onClick={yes} className={cn(!canYes && 'opacity-60')}>
            <CheckIcon className="size-3.5" />
            {ask.kind === 'question' ? t('send') : t('approve')}
          </Button>
        </div>
      </footer>
    </article>
  );
}
