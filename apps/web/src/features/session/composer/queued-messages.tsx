'use client';

/**
 * The queue, as something you can actually work with.
 *
 * What this replaces was a single truncated line per message with an X — no
 * count, no ordering, no way to fix a typo, no way to say "actually, send this
 * one now", and no sign at all when a send had failed. If the queue is going to
 * hold your words for minutes at a time, it has to let you change your mind
 * about them.
 *
 * Presentation only. Every mutation goes out through a prop; the store owns the
 * state and the drain owns the timing.
 */

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  ClockIcon,
  PaperPlaneTiltIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  nextFocusAfterRemove,
  queueSummaryLabel,
  reorderTargetIndex,
  shouldExpandQueue,
} from './queued-messages-logic';

/** Structural, so callers do not have to import the store's types. */
export interface QueuedMessageView {
  id: string;
  text: string;
  /** Attachments that did not survive being stored. Non-zero means say so. */
  lostAttachments?: number;
  /** Present on a message in the failed list. */
  lastError?: string;
}

export interface QueuedMessagesProps {
  messages: QueuedMessageView[];
  failed?: QueuedMessageView[];
  /** The message currently on the wire. It cannot be edited, moved or removed. */
  inFlightId?: string | null;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  onReorder?: (id: string, toIndex: number) => void;
  /** Stop the running turn and send this one. The only interrupting action. */
  onSendNow?: (id: string) => void;
  onRetry?: (id: string) => void;
}

const ROW_TRANSITION = { type: 'spring', duration: 0.3, bounce: 0 } as const;

/** Icon button sized for the composer's chip density. */
function RowAction({
  label,
  onClick,
  disabled,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Hint label={label} side="top">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10',
          'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md',
          'transition-[color,background-color,transform] active:scale-[0.97]',
          'disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

function QueuedRow({
  message,
  index,
  total,
  minIndex,
  isInFlight,
  onRemove,
  onEdit,
  onReorder,
  onSendNow,
  onFocusSibling,
}: {
  message: QueuedMessageView;
  index: number;
  total: number;
  minIndex: number;
  isInFlight: boolean;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  onReorder?: (id: string, toIndex: number) => void;
  onSendNow?: (id: string) => void;
  onFocusSibling: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (next === message.text) return;
    // An emptied message is a removal — asking the user to press a second
    // button to finish a decision they just expressed is friction for nothing.
    onEdit?.(message.id, next);
  }, [draft, message.id, message.text, onEdit]);

  const cancel = useCallback(() => {
    setDraft(message.text);
    setEditing(false);
  }, [message.text]);

  const move = useCallback(
    (direction: 'up' | 'down') => {
      const target = reorderTargetIndex(index, direction, total, minIndex);
      if (target === null) return;
      onReorder?.(message.id, target);
    },
    [index, total, minIndex, onReorder, message.id],
  );

  const canReorder = !!onReorder && !isInFlight;

  return (
    <m.li
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 2 }}
      transition={ROW_TRANSITION}
      tabIndex={-1}
      data-queued-id={message.id}
      onKeyDown={(event) => {
        if (editing) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          if (!canReorder) return;
          event.preventDefault();
          move(event.key === 'ArrowUp' ? 'up' : 'down');
        }
      }}
      className={cn(
        'group border-border/60 bg-muted/40 flex items-center gap-2 rounded-md border px-2.5 py-1.5',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        isInFlight && 'opacity-70',
      )}
    >
      <ClockIcon className="text-muted-foreground/70 size-3 shrink-0" />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
          aria-label="Edit queued message"
          className="text-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={isInFlight || !onEdit}
          onClick={() => setEditing(true)}
          className="text-muted-foreground min-w-0 flex-1 cursor-text truncate text-left text-xs disabled:cursor-default"
        >
          {message.text}
        </button>
      )}

      {message.lostAttachments ? (
        <Hint
          label={`${message.lostAttachments} attachment${message.lostAttachments === 1 ? '' : 's'} could not be restored after reload and will not be sent`}
          side="top"
        >
          <span className="text-kortix-orange flex shrink-0 items-center gap-1 text-xs">
            <PaperclipIcon className="size-3" />
            {message.lostAttachments}
          </span>
        </Hint>
      ) : null}

      {isInFlight ? (
        <span className="text-muted-foreground/70 shrink-0 text-xs">Sending…</span>
      ) : (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {canReorder && (
            <>
              <RowAction
                label="Move up"
                onClick={() => move('up')}
                disabled={reorderTargetIndex(index, 'up', total, minIndex) === null}
              >
                <CaretUpIcon className="size-3" />
              </RowAction>
              <RowAction
                label="Move down"
                onClick={() => move('down')}
                disabled={reorderTargetIndex(index, 'down', total, minIndex) === null}
              >
                <CaretDownIcon className="size-3" />
              </RowAction>
            </>
          )}
          {onEdit && !editing && (
            <RowAction label="Edit" onClick={() => setEditing(true)}>
              <PencilSimpleIcon className="size-3" />
            </RowAction>
          )}
          {onSendNow && (
            // The one control that interrupts a running turn, and it says so.
            <RowAction label="Stop & send" onClick={() => onSendNow(message.id)}>
              <PaperPlaneTiltIcon className="size-3" />
            </RowAction>
          )}
          {onRemove && (
            <RowAction
              label="Remove from queue"
              onClick={() => {
                onFocusSibling(message.id);
                onRemove(message.id);
              }}
            >
              <XIcon className="size-3" />
            </RowAction>
          )}
        </span>
      )}
    </m.li>
  );
}

export function QueuedMessages({
  messages,
  failed = [],
  inFlightId = null,
  onRemove,
  onEdit,
  onReorder,
  onSendNow,
  onRetry,
}: QueuedMessagesProps) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const expanded = shouldExpandQueue(messages.length, userToggled);
  // Nothing may be reordered into or above a message already being sent.
  const minIndex = inFlightId ? 1 : 0;

  /** Keep the keyboard in the list when a row is removed from under it. */
  const focusAfterRemove = useCallback(
    (removedId: string) => {
      const index = messages.findIndex((m) => m.id === removedId);
      const nextId = nextFocusAfterRemove(
        messages.map((m) => m.id),
        index,
      );
      if (!nextId) return;
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-queued-id="${CSS.escape(nextId)}"]`)
          ?.focus();
      });
    },
    [messages],
  );

  if (messages.length === 0 && failed.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Announced politely: a queue that grows or drains while you are typing
          is a change screen-reader users otherwise have no way to notice. */}
      <p className="sr-only" aria-live="polite">
        {queueSummaryLabel(messages.length)}
      </p>

      {messages.length >= 2 && (
        <button
          type="button"
          onClick={() => setUserToggled(!expanded)}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 px-1 text-left text-xs transition-colors"
        >
          <CaretDownIcon
            className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90')}
          />
          <span aria-hidden>{queueSummaryLabel(messages.length)}</span>
        </button>
      )}

      <ul
        ref={listRef}
        // The cap keeps a long queue from pushing the textarea off screen; the
        // list scrolls inside itself instead.
        className={cn('space-y-1.5', expanded && 'max-h-[40vh] overflow-y-auto')}
      >
        <AnimatePresence initial={false}>
          {(expanded ? messages : messages.slice(0, 2)).map((message, index) => (
            <QueuedRow
              key={message.id}
              message={message}
              index={index}
              total={messages.length}
              minIndex={minIndex}
              isInFlight={message.id === inFlightId}
              onRemove={onRemove}
              onEdit={onEdit}
              onReorder={onReorder}
              onSendNow={onSendNow}
              onFocusSibling={(id) => id && focusAfterRemove(id)}
            />
          ))}
        </AnimatePresence>
      </ul>

      {!expanded && messages.length > 2 && (
        <button
          type="button"
          onClick={() => setUserToggled(true)}
          className="text-muted-foreground hover:text-foreground cursor-pointer px-1 text-left text-xs transition-colors"
        >
          Show {messages.length - 2} more
        </button>
      )}

      {/* Failed sends live below the queue, never in it — a failure must not
          hold up the messages behind it. */}
      {failed.length > 0 && (
        <ul className="space-y-1.5">
          <AnimatePresence initial={false}>
            {failed.map((message) => (
              <m.li
                key={message.id}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 2 }}
                transition={ROW_TRANSITION}
                className="border-kortix-red/25 bg-kortix-red/[0.06] flex items-center gap-2 rounded-md border px-2.5 py-1.5"
              >
                <WarningIcon className="text-kortix-red size-3 shrink-0" weight="fill" />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {message.text}
                </span>
                {message.lastError && (
                  <Hint label={message.lastError} side="top">
                    <span className="text-kortix-red shrink-0 text-xs">Failed</span>
                  </Hint>
                )}
                {onRetry && (
                  <RowAction label="Retry" onClick={() => onRetry(message.id)}>
                    <ArrowClockwiseIcon className="size-3" />
                  </RowAction>
                )}
                {onRemove && (
                  <RowAction label="Dismiss" onClick={() => onRemove(message.id)}>
                    <XIcon className="size-3" />
                  </RowAction>
                )}
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
