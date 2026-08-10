'use client';

/**
 * The queue, shown as what it is: a numbered list of what goes next.
 *
 * The queue is first come, first served — `1` sends when this turn ends, then
 * `2`, then `3`. The number in each row says that outright, which is why there
 * is no header explaining it and no summary line to collapse.
 *
 * ## What was here before, and why it went
 *
 *   - **Two collapse controls for one list.** A caret header ("3 queued · sends
 *     when this turn ends") that hid rows past the second, *and* a separate
 *     "Show 2 more" button underneath. Two affordances, same job, and neither
 *     was doing anything a five-row list needed. A long queue now scrolls inside
 *     itself instead of hiding behind a toggle.
 *   - **A second list.** Failed sends rendered in their own `<ul>` below the
 *     queue, which read as two queues. There is one queue; a failure is a row in
 *     it that needs attention.
 *   - **"Stop & send".** A one-click interrupt of a running turn, sitting in a
 *     hover-revealed strip beside four other icons. Killing the agent mid-task
 *     should not be a thing you can do by aiming slightly wrong.
 *   - **Motion on every row.** `layout` + a spring on enter, exit, and reorder.
 *     A queue changes because the user removed something or the agent consumed
 *     something; both are already visible. Animating them adds a wait to a fact.
 *     Rows now appear and leave instantly. The only motion left is the press
 *     feedback on a button, which is interaction, not decoration.
 *
 * Presentation only. Every mutation goes out through a prop; the store owns the
 * state and the drain owns the timing.
 */

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  PaperclipIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextFocusAfterRemove, queueSummaryLabel, reorderTargetIndex } from './queued-messages-logic';

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
  onRetry?: (id: string) => void;
}

/**
 * A row's dismiss control.
 *
 * Always visible rather than revealed on hover: the queue exists so you can
 * change your mind, and hiding the control that lets you do it behind a hover
 * makes the one routine action the least discoverable thing on the row. It sits
 * at low contrast until the row is hovered so a full queue still reads calm.
 *
 * The visible box is 20px for the composer's chip density; `before:` extends the
 * *hit* area without changing the layout. It lands at 36×40 rather than the
 * usual 40×40 minimum, and that is deliberate: rows sit on a ~37px pitch, so a
 * 40px-tall target would overlap its neighbour's — and two overlapping targets
 * is a worse failure than a 36px one, because it makes the wrong row's × the
 * thing you hit. Width is free, so it takes the full 40 there.
 */
function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Hint label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm',
          'text-muted-foreground/50 group-hover:text-muted-foreground',
          'hover:!text-foreground hover:bg-muted-foreground/10',
          'transition-[color,background-color,scale] active:scale-[0.96]',
          'before:absolute before:top-1/2 before:left-1/2 before:h-9 before:w-10',
          'before:-translate-x-1/2 before:-translate-y-1/2 before:content-[""]',
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

/**
 * The send-order marker.
 *
 * `tabular-nums` because the column must not reflow when the queue crosses from
 * 9 to 10 — a number that shifts the text beside it is worse than no number.
 */
function Position({ children, tone }: { children: React.ReactNode; tone?: 'failed' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center text-[11px] tabular-nums',
        tone === 'failed' ? 'text-kortix-red' : 'text-muted-foreground/60',
      )}
    >
      {children}
    </span>
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

  const canReorder = !!onReorder && !isInFlight;

  return (
    <li
      tabIndex={-1}
      data-queued-id={message.id}
      onKeyDown={(event) => {
        if (editing) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          // Reorder has no buttons of its own. Four hover-revealed carets to
          // move two rows was more chrome than the action was worth, and the
          // keys work from the row you already focused to remove or edit.
          if (!canReorder) return;
          const target = reorderTargetIndex(index, event.key === 'ArrowUp' ? 'up' : 'down', total, minIndex);
          if (target === null) return;
          event.preventDefault();
          onReorder?.(message.id, target);
        }
      }}
      className={cn(
        'group bg-popover flex items-center gap-2 rounded-md border px-2.5 py-1.5',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        isInFlight && 'opacity-70',
      )}
    >
      <Position>{index + 1}</Position>

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
          <span className="text-kortix-orange flex shrink-0 items-center gap-1 text-xs tabular-nums">
            <PaperclipIcon className="size-3" />
            {message.lostAttachments}
          </span>
        </Hint>
      ) : isInFlight ? (
        <span className="text-muted-foreground/70 shrink-0 text-xs">Sending…</span>
      ) : onRemove ? (
        <RowAction
          label="Remove from queue"
          onClick={() => {
            onFocusSibling(message.id);
            onRemove(message.id);
          }}
        >
          <XIcon className="size-3" />
        </RowAction>
      ) : null}
    </li>
  );
}

/**
 * Whether the list is taller than its cap, so the bottom edge can be faded.
 *
 * Without this the cap clips the next row mid-height and the queue looks
 * broken rather than scrollable — the one honest job the removed "Show 2 more"
 * button was doing. A fade says "this continues" without costing a control, and
 * it only appears when there is actually something below.
 */
function useOverflowing(ref: React.RefObject<HTMLElement | null>, deps: number) {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, deps]);
  return overflowing;
}

export function QueuedMessages({
  messages,
  failed = [],
  inFlightId = null,
  onRemove,
  onEdit,
  onReorder,
  onRetry,
}: QueuedMessagesProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const overflowing = useOverflowing(listRef, messages.length + failed.length);
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
    <>
      {/* Announced politely: a queue that grows or drains while you are typing
          is a change screen-reader users otherwise have no way to notice. The
          sighted equivalent is the numbers, not a header. */}
      <p className="sr-only" aria-live="polite">
        {queueSummaryLabel(messages.length)}
      </p>

      {/* ONE list. Failures are rows in the queue that need attention, not a
          second queue below it. The cap keeps a long queue from pushing the
          textarea off screen — it scrolls inside itself rather than hiding
          rows behind a toggle nobody asked for. */}
      <ul
        ref={listRef}
        // The mask fades the last 24px so a clipped row reads as "scroll", not
        // as a rendering fault. It masks rather than paints, so it needs no
        // colour and is correct in both themes by construction.
        style={
          overflowing
            ? {
                maskImage: 'linear-gradient(to bottom, #000 calc(100% - 24px), transparent)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 24px), transparent)',
              }
            : undefined
        }
        className="max-h-40 space-y-1.5 overflow-y-auto"
      >
        {messages.map((message, index) => (
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
            onFocusSibling={(id) => id && focusAfterRemove(id)}
          />
        ))}

        {failed.map((message) => (
          <li
            key={message.id}
            className="group border-kortix-red/25 bg-kortix-red/[0.06] flex items-center gap-2 rounded-md border px-2.5 py-1.5"
          >
            <Position tone="failed">
              <WarningIcon className="size-3" weight="fill" />
            </Position>
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
          </li>
        ))}
      </ul>
    </>
  );
}
