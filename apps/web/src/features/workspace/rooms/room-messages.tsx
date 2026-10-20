'use client';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import Hint from '@kortix/ui/hint';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import type { RoomMessage } from '@kortix/sdk';
import { ArrowDownIcon, ChatTeardropTextIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { ParticipantAvatar } from './room-identity';
import { groupMessages, relativeTime, sessionDisplay, splitMessageText, type MentionTarget } from './room-text';

/** How close to the bottom (px) still counts as "reading the newest message". */
const STICK_TO_BOTTOM_PX = 120;
/** How long a jumped-to message keeps its highlight before it fades. */
const HIGHLIGHT_MS = 2_000;

export interface SenderView {
  name: string;
  detail: string | null;
  agent: boolean;
  href: string | null;
}

export function senderView(projectId: string, message: RoomMessage): SenderView {
  if (message.sender_kind === 'session') {
    const { name, detail } = sessionDisplay(message.sender_label);
    return {
      name,
      detail,
      agent: true,
      href: message.sender_session_id ? `/projects/${projectId}/sessions/${message.sender_session_id}` : null,
    };
  }
  return { name: message.sender_label, detail: null, agent: false, href: null };
}

/** One person or agent who replied in a thread, for the summary's avatar stack. */
export interface Replier {
  key: string;
  kind: 'session' | 'person';
  label: string;
  userId: string | null;
}

export function repliersOf(replies: readonly RoomMessage[]): Replier[] {
  const seen = new Map<string, Replier>();
  for (const m of replies) {
    const key = m.sender_session_id ?? m.sender_user_id ?? m.sender_label;
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        kind: m.sender_kind === 'session' ? 'session' : 'person',
        label: m.sender_label,
        userId: m.sender_user_id,
      });
    }
  }
  return [...seen.values()].slice(0, 3);
}

/** Clock, full date and "N minutes ago", formatted once per list for the viewer's locale. */
function useTimeFormat() {
  const locale = useLocale();
  return useMemo(() => {
    const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const exact = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' });
    const day = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' });
    const dayWithYear = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return { locale, clock, exact, day, dayWithYear };
  }, [locale]);
}

/**
 * A run of messages, Slack-style: one header per run of messages by one
 * sender within 5 minutes, a sticky day pill, a "New" line at the viewer's
 * read cursor on open, a hover toolbar, thread summaries under a root, and
 * mention chips. It follows new messages while the reader sits at the bottom;
 * otherwise it offers "Jump to latest". The room timeline and the thread
 * panel both render it.
 */
export function RoomMessageList({
  projectId,
  messages,
  intro,
  introAlways = false,
  dayDividers = true,
  newFromSeq,
  targets,
  atBottomRef,
  highlightSeq = null,
  repliers,
  onOpenThread,
}: {
  projectId: string;
  messages: RoomMessage[];
  /** Shown above the first message when the list starts at the room's first message (or `introAlways`). */
  intro: ReactNode;
  introAlways?: boolean;
  /** The room shows a sticky day pill per day; a thread (one conversation) does not. */
  dayDividers?: boolean;
  /** The first unread seq when the room opened; null when nothing was unread. */
  newFromSeq: number | null;
  targets: MentionTarget[];
  /** Owned by the caller, so sending a message can pin the list to the bottom. */
  atBottomRef: RefObject<boolean>;
  /** A message opened by link: scrolled into view once and highlighted. */
  highlightSeq?: number | null;
  /** Replier avatars per thread root, when that thread is loaded. */
  repliers?: ReadonlyMap<number, Replier[]>;
  /** Set on the room timeline: the toolbar and the summary open a thread. */
  onOpenThread?: (seq: number) => void;
}) {
  const t = useTranslations('rooms');
  const format = useTimeFormat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  // The linked message stays highlighted until its timer marks it faded.
  const [fadedSeq, setFadedSeq] = useState<number | null>(null);
  const highlighted = highlightSeq !== null && fadedSeq !== highlightSeq ? highlightSeq : null;
  const days = useMemo(() => groupMessages(messages), [messages]);

  const dayLabel = (start: number) => {
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (start === midnight) return t('today');
    if (start === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) return t('yesterday');
    const date = new Date(start);
    return (date.getFullYear() === today.getFullYear() ? format.day : format.dayWithYear).format(date);
  };

  // First paint: land on the linked message, else the "New" line, else the bottom.
  const landedRef = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0 || landedRef.current) return;
    landedRef.current = true;
    const target =
      (highlightSeq !== null ? el.querySelector<HTMLElement>(`[data-seq="${highlightSeq}"]`) : null) ??
      (newFromSeq !== null ? el.querySelector<HTMLElement>('[data-new-marker]') : null);
    if (target) {
      el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 3);
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
      setShowJump(!atBottomRef.current);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, newFromSeq, highlightSeq, atBottomRef]);

  // A linked message highlights once, then fades (the transition is on the row).
  useEffect(() => {
    if (highlightSeq === null) return;
    const timer = setTimeout(() => setFadedSeq(highlightSeq), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightSeq]);

  // Follow new messages while the reader is at the bottom.
  const newest = messages[messages.length - 1]?.seq ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && landedRef.current && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [newest, atBottomRef]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  // Replies are not in the room timeline, so the read cursor can sit inside a
  // thread: the line goes above the first top-level message at or after it.
  const firstNewSeq = newFromSeq === null ? null : (messages.find((m) => m.seq >= newFromSeq)?.seq ?? null);
  const showIntro = introAlways || messages.length === 0 || messages[0]!.seq === 1;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
          atBottomRef.current = atBottom;
          setShowJump(!atBottom);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex min-h-full flex-col justify-end pt-4 pb-3">
          {showIntro ? <div className="pb-4">{intro}</div> : null}
          <ol aria-label={t('messages')} className="space-y-3">
            {days.map((day) => (
              <li key={day.key} className={cn(dayDividers && 'border-border border-t')}>
                {dayDividers ? (
                  <div className="sticky top-2 z-10 -mt-3 flex justify-center">
                    <span className="bg-background border-border text-foreground rounded-full border px-3 py-0.5 text-xs font-medium">
                      {dayLabel(day.start)}
                    </span>
                  </div>
                ) : null}
                <ol className="pt-1.5">
                  {day.items.map(({ message, continuation }) => {
                    const isNew = message.seq === firstNewSeq;
                    return (
                      <li key={message.message_id}>
                        {isNew ? <NewMarker label={t('new')} /> : null}
                        <MessageRow
                          projectId={projectId}
                          message={message}
                          continuation={continuation && !isNew}
                          highlighted={highlighted === message.seq}
                          linked={highlightSeq === message.seq}
                          format={format}
                          targets={targets}
                          repliers={repliers?.get(message.seq)}
                          onOpenThread={onOpenThread ? () => onOpenThread(message.seq) : undefined}
                        />
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        </div>
      </div>
      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button size="xs" variant="secondary" className="pointer-events-auto shadow-md" onClick={jumpToLatest}>
            <ArrowDownIcon className="size-3.5 shrink-0" />
            {t('jumpToLatest')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NewMarker({ label }: { label: string }) {
  return (
    <div data-new-marker role="separator" aria-label={label} className="flex items-center gap-2 px-5 py-1">
      <span aria-hidden className="border-kortix-blue flex-1 border-t" />
      <Badge variant="info" size="xs">
        {label}
      </Badge>
    </div>
  );
}

export function MessageRow({
  projectId,
  message,
  continuation = false,
  highlighted = false,
  linked = false,
  format,
  targets,
  repliers,
  onOpenThread,
}: {
  projectId: string;
  message: RoomMessage;
  continuation?: boolean;
  highlighted?: boolean;
  /** Opened by link: its highlight fades out (300 ms). Other rows hover with no transition. */
  linked?: boolean;
  format: ReturnType<typeof useTimeFormat>;
  targets: MentionTarget[];
  repliers?: Replier[];
  onOpenThread?: () => void;
}) {
  const t = useTranslations('rooms');
  const sender = senderView(projectId, message);
  const parts = useMemo(() => splitMessageText(message.text, targets), [message.text, targets]);
  const at = new Date(message.created_at);
  const stamp = (
    <time dateTime={message.created_at} title={format.exact.format(at)} className="tabular-nums">
      {format.clock.format(at)}
    </time>
  );
  const replies = message.reply_count;

  return (
    <div
      data-seq={message.seq}
      className={cn(
        'group/message hover:bg-hover focus-within:bg-hover relative flex gap-2 px-5',
        linked && 'duration-slow transition-colors ease-out motion-reduce:transition-none',
        continuation ? 'py-0.5' : 'pt-1.5 pb-0.5',
        highlighted && 'bg-kortix-yellow/15',
      )}
    >
      <div className="w-10 shrink-0">
        {continuation ? (
          <span className="text-muted-foreground invisible block pt-0.5 text-right text-xs group-hover/message:visible">
            {stamp}
          </span>
        ) : (
          <ParticipantAvatar
            kind={sender.agent ? 'session' : 'person'}
            label={message.sender_label}
            userId={message.sender_user_id}
            size="lg"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {continuation ? null : (
          <div className="flex min-w-0 items-baseline gap-1.5">
            {sender.href ? (
              <Link href={sender.href} className="text-foreground truncate text-sm font-semibold hover:underline">
                {sender.name}
              </Link>
            ) : (
              <span className="text-foreground truncate text-sm font-semibold">{sender.name}</span>
            )}
            {sender.agent ? (
              <Badge variant="default" size="xs" className="self-center">
                {t('agent')}
              </Badge>
            ) : null}
            {sender.detail ? <span className="text-muted-foreground min-w-0 truncate text-xs">{sender.detail}</span> : null}
            <span className="text-muted-foreground shrink-0 text-xs">{stamp}</span>
          </div>
        )}
        {/* Plain text: a message is untrusted input, never HTML. */}
        <p className="text-foreground text-sm break-words whitespace-pre-wrap wrap-anywhere">
          {parts.map((part, i) =>
            part.kind === 'text' ? (
              part.text
            ) : part.kind === 'link' ? (
              <a
                key={i}
                href={part.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-kortix-base underline-offset-2 hover:underline"
              >
                {part.href}
              </a>
            ) : (
              <span
                key={i}
                title={`@${part.token}`}
                className={cn(
                  'text-foreground rounded-sm px-0.5 font-medium',
                  part.self ? 'bg-kortix-yellow/15' : 'bg-kortix-blue/15',
                )}
              >
                {part.label}
              </span>
            ),
          )}
        </p>
        {onOpenThread && replies > 0 ? (
          <ThreadSummary
            count={replies}
            lastReplyAt={message.last_reply_at}
            repliers={repliers}
            locale={format.locale}
            onOpen={onOpenThread}
          />
        ) : null}
      </div>
      <MessageToolbar text={message.text} onOpenThread={onOpenThread} />
    </div>
  );
}

/** "[avatars] 2 replies  Last reply 5 minutes ago" under a root (Slack). */
function ThreadSummary({
  count,
  lastReplyAt,
  repliers,
  locale,
  onOpen,
}: {
  count: number;
  lastReplyAt: string | null;
  repliers?: Replier[];
  locale: string;
  onOpen: () => void;
}) {
  const t = useTranslations('rooms');
  // The relative label is read when the row renders; the room polls every 3 s.
  const [now] = useState(() => Date.now());
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/thread hover:bg-popover hover:border-border -ml-1 mt-1 flex max-w-full items-center gap-2 rounded-md border border-transparent p-1 pr-2 text-left text-xs"
    >
      {repliers && repliers.length > 0 ? (
        <span className="flex shrink-0 -space-x-1">
          {repliers.map((r) => (
            <span key={r.key} className="ring-background rounded-sm ring-2">
              <ParticipantAvatar kind={r.kind} label={r.label} userId={r.userId} size="xs" />
            </span>
          ))}
        </span>
      ) : null}
      <span className="text-kortix-base shrink-0 font-medium">{t('replyCount', { count })}</span>
      {lastReplyAt ? (
        <span className="text-muted-foreground min-w-0 truncate">
          {t('lastReply', { time: relativeTime(lastReplyAt, now, locale) })}
        </span>
      ) : null}
    </button>
  );
}

function MessageToolbar({ text, onOpenThread }: { text: string; onOpenThread?: () => void }) {
  const t = useTranslations('rooms');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="bg-popover border-border absolute -top-3.5 right-5 z-10 hidden rounded-md border p-0.5 shadow-md group-focus-within/message:flex group-hover/message:flex">
      <ButtonGroup>
        {onOpenThread ? (
          <Hint label={t('replyInThread')} side="top">
            <Button variant="ghost" size="icon-xs" aria-label={t('replyInThread')} onClick={onOpenThread}>
              <ChatTeardropTextIcon />
            </Button>
          </Hint>
        ) : null}
        <Hint label={copied ? t('copied') : t('copyText')} side="top">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copied ? t('copied') : t('copyText')}
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => setCopied(true));
            }}
          >
            {copied ? <CheckIcon className="text-kortix-green" /> : <CopyIcon />}
          </Button>
        </Hint>
      </ButtonGroup>
    </div>
  );
}

export { useTimeFormat };
