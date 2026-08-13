'use client';

/**
 * The queue, shown as a flat list of what goes next — one borderless row per
 * message, queue glyph on the left, actions on the right.
 *
 * All of it sends when this turn ends, as one message, top to bottom. That is
 * why there is no number column and no reorder control: the order is the list,
 * and nothing in it waits for anything else.
 *
 * ## The row anatomy
 *
 *   - **Leading queue glyph**, not a number. A batch that sends at once does
 *     not need per-row arithmetic; the glyph says "queued" and the position
 *     says the order.
 *   - **Actions are always visible, muted.** The previous design hid them
 *     until hover, which made a row at rest read as inert text. They now sit
 *     at `text-muted-foreground` and brighten on hover — present without
 *     shouting, and reachable without a hover hunt.
 *   - **Pencil** edits the row (clicking the text edits too); **trash**
 *     removes it. Two direct controls, no overflow menu — two actions do not
 *     need a third click to reach them.
 *
 * ## What is deliberately NOT here
 *
 *   - **Reorder.** The batch sends as one message, so moving row 3 above
 *     row 2 changes nothing a user can observe.
 *   - **In-flight rows.** A message on the wire is no longer "queued next" —
 *     it renders as nothing here rather than as a locked row.
 *   - **Per-row borders.** Seven bordered cards stacked in the composer strip
 *     read as seven separate surfaces; a queue is one thing.
 *   - **Motion on enter/exit.** A queue changes because the user removed
 *     something or the agent consumed something; both are already visible.
 *     The only motion is press feedback, which is interaction, not decoration.
 *
 * Presentation only. Every mutation goes out through a prop; the store owns
 * the state and the drain owns the timing.
 */

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  QueueIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  nextFocusAfterRemove,
  pausedSummaryLabel,
  queueSummaryLabel,
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
  /**
   * The messages currently on the wire, oldest first.
   *
   * Plural because the queue drains as a batch: one prompt carries every
   * message that was waiting. A row on the wire is not rendered — it has left
   * the queue in every way a user can act on.
   */
  inFlightIds?: string[];
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  onRetry?: (id: string) => void;
  /**
   * The queue is held by a stop and will not drain on its own.
   *
   * Dims the list, and switches what the live region announces — "sends when
   * this turn ends" is a lie while paused, and that lie is what made a stopped
   * queue look like a broken one. The dim is the whole signal, so do not
   * remove it without replacing it — a paused queue with no indication at all
   * is indistinguishable from a broken one.
   */
  paused?: boolean;
  /** The agent is mid-turn. Kept for callers; the rows render the same either way. */
  isRunning?: boolean;
  /** Send this message now — stopping the current turn first if one is running. */
  onSendNow?: (id: string) => void;
}

/**
 * One icon control in a row's trailing action strip.
 *
 * Always visible at muted strength — a control you can see is a control you
 * can find, and the strip is what makes a queued row more than dead text.
 *
 * The visible box is 24px for the composer's row density; `before:` extends
 * the *hit* area without changing the layout. Rows sit on a ~28px pitch, so
 * the hit area caps at 28px tall — two overlapping targets is a worse failure
 * than a slightly short one, because it makes the wrong row's button the
 * thing you hit. Width is free, so it takes a full 32 there.
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
          'relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm',
          'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10',
          'transition-[color,background-color,scale] active:scale-[0.96]',
          'before:absolute before:top-1/2 before:left-1/2 before:h-7 before:w-8',
          'before:-translate-x-1/2 before:-translate-y-1/2 before:content-[""]',
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

function QueuedRow({
  message,
  onRemove,
  onEdit,
  onFocusSibling,
}: {
  message: QueuedMessageView;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  onFocusSibling: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
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

  return (
    <li
      tabIndex={-1}
      data-queued-id={message.id}
      className={cn(
        'group flex items-center gap-2 rounded-md px-1.5 py-1',
        'hover:bg-muted-foreground/[0.06]',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
      )}
    >
      <QueueIcon aria-hidden className="text-muted-foreground/60 size-3.5 shrink-0" />

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
          disabled={!onEdit}
          onClick={() => setEditing(true)}
          className="text-foreground/90 min-w-0 flex-1 cursor-text truncate text-left text-xs disabled:cursor-default"
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
      ) : null}

      <span className="flex shrink-0 items-center gap-0.5">
        {onEdit && (
          <RowAction label="Edit message" onClick={() => setEditing(true)}>
            <PencilSimpleIcon className="size-3.5" />
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
            <TrashIcon className="size-3.5" />
          </RowAction>
        )}
      </span>
    </li>
  );
}

/** Stable identity, so the default does not look like a change every render. */
const EMPTY_IN_FLIGHT: string[] = [];

export function QueuedMessages({
  messages,
  failed = [],
  inFlightIds = EMPTY_IN_FLIGHT,
  onRemove,
  onEdit,
  onRetry,
  paused = false,
}: QueuedMessagesProps) {
  const listRef = useRef<HTMLUListElement>(null);

  /**
   * In-flight rows are filtered HERE, before any render decision — not hidden
   * row-by-row. A message on the wire is no longer queued in any way the user
   * can act on, and a component that renders its shell around zero visible
   * rows defeats the `:empty` check the composer's strip relies on to
   * disappear: the shell itself was the "phantom sliver above the composer".
   */
  const visibleMessages = messages.filter((m) => !inFlightIds.includes(m.id));

  /** Keep the keyboard in the list when a row is removed from under it. */
  const focusAfterRemove = useCallback(
    (removedId: string) => {
      const index = visibleMessages.findIndex((m) => m.id === removedId);
      const nextId = nextFocusAfterRemove(
        visibleMessages.map((m) => m.id),
        index,
      );
      if (!nextId) return;
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-queued-id="${CSS.escape(nextId)}"]`)
          ?.focus();
      });
    },
    [visibleMessages],
  );

  if (visibleMessages.length === 0 && failed.length === 0) return null;

  return (
    <>
      {/* Announced politely: a queue that grows or drains while you are typing
          is a change screen-reader users otherwise have no way to notice. */}
      <p className="sr-only" aria-live="polite">
        {paused
          ? pausedSummaryLabel(visibleMessages.length)
          : queueSummaryLabel(visibleMessages.length)}
      </p>

      {/* ONE list. Failures are rows in the queue that need attention, not a
          second queue below it. The cap keeps a long queue from pushing the
          textarea off screen — it scrolls inside itself, and FadedScrollArea
          fades whichever edge has more rows beyond it, so a clipped row reads
          as "scroll", not as a rendering fault. The strip is `bg-sidebar`, so
          the default `from-sidebar` fade matches by construction. */}
      <FadedScrollArea rootClassName="w-full" className="max-h-40">
        <ul ref={listRef} className={cn('w-full', paused && 'opacity-60')}>
          {visibleMessages.map((message) => (
            <QueuedRow
              key={message.id}
              message={message}
              onRemove={onRemove}
              onEdit={onEdit}
              onFocusSibling={(id) => id && focusAfterRemove(id)}
            />
          ))}

          {failed.map((message) => (
            <li key={message.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1">
              <WarningIcon weight="fill" className="text-kortix-red size-3.5 shrink-0" />
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
                  <ArrowClockwiseIcon className="size-3.5" />
                </RowAction>
              )}
              {onRemove && (
                <RowAction label="Dismiss" onClick={() => onRemove(message.id)}>
                  <TrashIcon className="size-3.5" />
                </RowAction>
              )}
            </li>
          ))}
        </ul>
      </FadedScrollArea>
    </>
  );
}
