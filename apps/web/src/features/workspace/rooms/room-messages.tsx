'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { RoomMessage } from '@kortix/sdk';
import { ArrowBendUpLeftIcon, ArrowDownIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { ParticipantAvatar } from './room-identity';
import { firstLine, groupMessages, sessionDisplay, splitMessageText, type MentionTarget } from './room-text';

/** How close to the bottom (px) still counts as "reading the newest message". */
const STICK_TO_BOTTOM_PX = 120;
/** How long a jumped-to message stays highlighted. */
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

/**
 * The conversation's messages, Slack-style: one header per run of messages by
 * one sender within 5 minutes, a sticky day divider, a "New" line at the
 * viewer's read cursor on open, a hover toolbar (Reply, Copy text), reply
 * quotes that jump to the quoted message, and mention chips. It follows new
 * messages while the reader sits at the bottom; otherwise "Jump to latest".
 */
export function RoomMessageList({
  projectId,
  messages,
  intro,
  newFromSeq,
  targets,
  atBottomRef,
  onReply,
}: {
  projectId: string;
  messages: RoomMessage[];
  /** The conversation's beginning, shown when the first message (seq 1) is loaded. */
  intro: ReactNode;
  /** The first unread seq when the conversation opened; null when nothing was unread. */
  newFromSeq: number | null;
  targets: MentionTarget[];
  /** Owned by the page, so sending a message can pin the list to the bottom. */
  atBottomRef: RefObject<boolean>;
  onReply: (message: RoomMessage) => void;
}) {
  const t = useTranslations('rooms');
  const locale = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const days = useMemo(() => groupMessages(messages), [messages]);
  const bySeq = useMemo(() => new Map(messages.map((m) => [m.seq, m])), [messages]);
  const format = useMemo(() => {
    const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const exact = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' });
    const day = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' });
    const dayWithYear = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return { clock, exact, day, dayWithYear };
  }, [locale]);

  const dayLabel = (start: number) => {
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (start === midnight) return t('today');
    if (start === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) return t('yesterday');
    const date = new Date(start);
    return (date.getFullYear() === today.getFullYear() ? format.day : format.dayWithYear).format(date);
  };

  // First paint: land on the "New" line when there is one, else at the bottom.
  const landedRef = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0 || landedRef.current) return;
    landedRef.current = true;
    const marker = newFromSeq !== null ? el.querySelector<HTMLElement>('[data-new-marker]') : null;
    if (marker) {
      el.scrollTop = Math.max(0, marker.offsetTop - el.clientHeight / 3);
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
      setShowJump(!atBottomRef.current);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, newFromSeq, atBottomRef]);

  // Follow new messages while the reader is at the bottom.
  const newest = messages[messages.length - 1]?.seq ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && landedRef.current && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [newest, atBottomRef]);

  useEffect(() => {
    if (highlighted === null) return;
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const jumpTo = (seq: number) => {
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    setHighlighted(seq);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  const showIntro = messages.length === 0 || messages[0]!.seq === 1;

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
        <div className="flex min-h-full flex-col justify-end pt-6 pb-4">
          {showIntro ? <div className="px-5 pb-6">{intro}</div> : null}
          <ol aria-label={t('messages')} className="space-y-4">
            {days.map((day) => (
              <li key={day.key} className="border-border border-t">
                <div className="sticky top-2 z-10 -mt-3 flex justify-center">
                  <span className="bg-background border-border text-foreground rounded-full border px-3 py-0.5 text-xs font-medium">
                    {dayLabel(day.start)}
                  </span>
                </div>
                <ol className="pt-2">
                  {day.items.map(({ message, continuation }) => {
                    const isNew = newFromSeq !== null && message.seq === newFromSeq;
                    const quoted = message.reply_to_seq ? bySeq.get(message.reply_to_seq) : undefined;
                    return (
                      <li key={message.message_id}>
                        {isNew ? <NewMarker label={t('new')} /> : null}
                        <MessageRow
                          projectId={projectId}
                          message={message}
                          continuation={continuation && !isNew}
                          highlighted={highlighted === message.seq}
                          time={{
                            clock: format.clock.format(new Date(message.created_at)),
                            exact: format.exact.format(new Date(message.created_at)),
                          }}
                          quote={
                            message.reply_to_seq
                              ? {
                                  seq: message.reply_to_seq,
                                  name: quoted ? senderView(projectId, quoted).name : null,
                                  text: quoted ? firstLine(quoted.text) : null,
                                }
                              : null
                          }
                          targets={targets}
                          onJump={jumpTo}
                          onReply={() => onReply(message)}
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

function MessageRow({
  projectId,
  message,
  continuation,
  highlighted,
  time,
  quote,
  targets,
  onJump,
  onReply,
}: {
  projectId: string;
  message: RoomMessage;
  continuation: boolean;
  highlighted: boolean;
  time: { clock: string; exact: string };
  quote: { seq: number; name: string | null; text: string | null } | null;
  targets: MentionTarget[];
  onJump: (seq: number) => void;
  onReply: () => void;
}) {
  const t = useTranslations('rooms');
  const sender = senderView(projectId, message);
  const parts = useMemo(() => splitMessageText(message.text, targets), [message.text, targets]);
  const stamp = (
    <time dateTime={message.created_at} title={time.exact} className="tabular-nums">
      {time.clock}
    </time>
  );

  return (
    <div
      data-seq={message.seq}
      className={cn(
        'group/message hover:bg-hover relative flex gap-2 px-5 focus-within:bg-hover',
        continuation ? 'py-0.5' : 'pt-2 pb-0.5',
        highlighted && 'bg-active',
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
          <div className="flex min-w-0 items-baseline gap-2">
            {sender.href ? (
              <Link href={sender.href} className="text-foreground truncate text-sm font-semibold hover:underline">
                {sender.name}
              </Link>
            ) : (
              <span className="text-foreground truncate text-sm font-semibold">{sender.name}</span>
            )}
            {sender.agent ? (
              <Badge variant="outline" size="xs" className="self-center">
                {t('agent')}
              </Badge>
            ) : null}
            {sender.detail ? <span className="text-muted-foreground min-w-0 truncate text-xs">{sender.detail}</span> : null}
            <span className="text-muted-foreground shrink-0 text-xs">{stamp}</span>
          </div>
        )}
        {quote ? (
          <button
            type="button"
            onClick={() => onJump(quote.seq)}
            className="text-muted-foreground hover:text-foreground flex max-w-full items-center gap-1 text-left text-xs"
          >
            <ArrowBendUpLeftIcon className="size-3 shrink-0" />
            {quote.name ? (
              <>
                <span className="text-foreground shrink-0 font-medium">{t('replyingTo', { name: quote.name })}</span>
                <span className="min-w-0 truncate">{quote.text}</span>
              </>
            ) : (
              <span className="truncate">{t('replyTo', { seq: quote.seq })}</span>
            )}
          </button>
        ) : null}
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
      </div>
      <MessageToolbar text={message.text} onReply={onReply} />
    </div>
  );
}

function MessageToolbar({ text, onReply }: { text: string; onReply: () => void }) {
  const t = useTranslations('rooms');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="bg-popover border-border absolute -top-3 right-5 z-10 hidden rounded-md border p-0.5 shadow-md group-focus-within/message:flex group-hover/message:flex">
      <ButtonGroup>
        <Hint label={t('reply')} side="top">
          <Button variant="ghost" size="icon-xs" aria-label={t('reply')} onClick={onReply}>
            <ArrowBendUpLeftIcon />
          </Button>
        </Hint>
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
