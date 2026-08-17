'use client';

/**
 * The queue, shown as a flat list of what goes next — one borderless row per
 * message, drag handle on the left, actions on the right.
 *
 * All of it sends when this turn ends, as one message, top to bottom. That is
 * why there is no number column: the order is the list. It is also why the
 * order gets a control — the batch is composed in list order, so moving a row
 * edits what the sent message says.
 *
 * ## The row anatomy
 *
 *   - **Leading drag handle** when there are two or more rows; the queue
 *     glyph when there is one, because a one-row queue has no order to
 *     change. Drag starts from the handle only (`dragListener={false}`) —
 *     the row body is click-to-edit, and a row that both drags and edits on
 *     the same press does neither reliably. The handle is also a focusable
 *     button: ArrowUp/ArrowDown move the row one slot, which is the keyboard
 *     path drag alone cannot provide.
 *   - **Actions are always visible, muted.** The previous design hid them
 *     until hover, which made a row at rest read as inert text. They now sit
 *     at `text-muted-foreground` and brighten on hover — present without
 *     shouting, and reachable without a hover hunt.
 *   - **Paper plane, only while paused** — sends the row now, alone, jumping
 *     the queue. Stop pauses the drain on purpose (an interrupt must not be
 *     followed a beat later by the message the user was getting ahead of),
 *     but before this button rendered, a paused queue had no way out except
 *     typing a new message. The dim says "held"; the planes appearing say
 *     "click to release". They do NOT render mid-run: the queue sends itself
 *     at the turn boundary then, and a standing interrupt button on every row
 *     is an accidental turn-kill waiting to happen. In the race window where
 *     the pause landed but the abort has not, the tooltip says it stops the
 *     current turn — because there it still does.
 *   - **Pencil** edits the row (clicking the text edits too); **trash**
 *     removes it. Direct controls, no overflow menu.
 *
 * ## Motion
 *
 * Rows still do not animate enter or exit — a queue changes because the user
 * removed something or the agent consumed something, and both are already
 * visible. The motion that exists is functional: press feedback on the
 * actions, and the layout spring (`duration 0.3, bounce 0`) that slides
 * siblings aside during a drag — that slide IS the drop preview, showing
 * where the row will land before it is released. Reduced motion drops the
 * spring to zero duration; the reorder still happens, it just stops moving.
 *
 * ## What is deliberately NOT here
 *
 *   - **In-flight rows.** A message on the wire is no longer "queued next" —
 *     it renders as nothing here rather than as a locked row.
 *   - **Per-row borders.** Seven bordered cards stacked in the composer strip
 *     read as seven separate surfaces; a queue is one thing. The dragged row
 *     is the one exception: it takes `bg-popover` + `shadow-xs` while lifted,
 *     because a row floating over its siblings must be opaque to read as
 *     floating at all.
 *   - **Store writes during the drag.** The visual order is local state while
 *     a drag is live; the store hears about it once, on release. Dispatching
 *     every intermediate swap would re-render the whole session tree
 *     mid-gesture for positions the user is already discarding.
 *
 * Presentation only. Every mutation goes out through a prop; the store owns
 * the state and the drain owns the timing.
 */

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  DotsSixVerticalIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  QueueIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { Reorder, useDragControls, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  nextFocusAfterRemove,
  pausedSummaryLabel,
  queueSummaryLabel,
  reorderTargetIndex,
  reorderToPendingIndex,
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
  /**
   * Move a message to `toIndex` — a position in `messages` as passed in,
   * in-flight rows included, matching the store's pending array. The drag
   * handle computes that index itself; see `reorderToPendingIndex`.
   */
  onReorder?: (id: string, toIndex: number) => void;
  onRetry?: (id: string) => void;
  /**
   * The queue is held by a stop and will not drain on its own.
   *
   * Dims the list, switches what the live region announces — "sends when
   * this turn ends" is a lie while paused, and that lie is what made a stopped
   * queue look like a broken one — and reveals the per-row send-now planes,
   * which are the hold's only visible way out. Do not remove either signal
   * without replacing it: a paused queue with no indication and no release
   * is indistinguishable from a broken one.
   */
  paused?: boolean;
  /**
   * The agent is mid-turn. Switches the send-now tooltip to say it stops the
   * current turn — sending now while the agent works is an interrupt, and a
   * control that interrupts without saying so teaches users not to trust it.
   */
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
  draggable,
  onMoveStep,
  onDragCommit,
  onSendNow,
  sendNowLabel = 'Send now',
  onFocusSibling,
}: {
  message: QueuedMessageView;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  /** False when the list has one row — one row has no order to change. */
  draggable: boolean;
  /** Keyboard path: move one visible slot. */
  onMoveStep: (id: string, direction: 'up' | 'down') => void;
  /** Pointer path: the drag ended; commit wherever the row was dropped. */
  onDragCommit: (id: string) => void;
  /** Present only while the queue is paused — the row's way out of the hold. */
  onSendNow?: (id: string) => void;
  sendNowLabel?: string;
  onFocusSibling: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragControls = useDragControls();
  const reduceMotion = useReducedMotion();

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
    <Reorder.Item
      value={message.id}
      dragListener={false}
      dragControls={dragControls}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0 }}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        setDragging(false);
        onDragCommit(message.id);
      }}
      tabIndex={-1}
      data-queued-id={message.id}
      className={cn(
        'group flex items-center gap-2 rounded-md px-1.5 py-1',
        'hover:bg-muted-foreground/[0.06]',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        // Lifted row: opaque over its siblings, one hairline of elevation.
        dragging && 'bg-popover relative z-10 shadow-xs',
      )}
    >
      {draggable ? (
        <button
          type="button"
          aria-label="Reorder message"
          data-drag-handle
          // `touch-none` so a touch drag reorders instead of scrolling the
          // strip; preventDefault so starting a drag does not also focus.
          onPointerDown={(event) => {
            event.preventDefault();
            dragControls.start(event);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            onMoveStep(message.id, event.key === 'ArrowUp' ? 'up' : 'down');
          }}
          className={cn(
            // `-m-[5px]` collapses the 24px box to the queue glyph's 14px
            // footprint, so the text column does not shift when the list
            // crosses the one-row threshold and the glyph swaps in.
            'relative -m-[5px] flex size-6 shrink-0 touch-none items-center justify-center rounded-sm',
            'text-muted-foreground/60 hover:text-foreground transition-[color]',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
            'before:absolute before:top-1/2 before:left-1/2 before:h-7 before:w-7',
            'before:-translate-x-1/2 before:-translate-y-1/2 before:content-[""]',
          )}
        >
          <DotsSixVerticalIcon className="size-3.5" />
        </button>
      ) : (
        <QueueIcon aria-hidden className="text-muted-foreground/60 size-3.5 shrink-0" />
      )}

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
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
        {onSendNow && (
          <RowAction label={sendNowLabel} onClick={() => onSendNow(message.id)}>
            <PaperPlaneRightIcon className="size-3.5" />
          </RowAction>
        )}
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
    </Reorder.Item>
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
  onReorder,
  onRetry,
  paused = false,
  isRunning = false,
  onSendNow,
}: QueuedMessagesProps) {
  const listRef = useRef<HTMLUListElement>(null);
  /** What the last move did, for the live region. Empty until a move happens. */
  const [moveAnnouncement, setMoveAnnouncement] = useState('');
  /**
   * The visual order while a drag is live, `null` otherwise. The ref mirrors
   * the state so `onDragEnd` — a stale closure by the time the pointer lifts —
   * can read the final order without re-subscribing per swap.
   */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);

  /**
   * In-flight rows are filtered HERE, before any render decision — not hidden
   * row-by-row. A message on the wire is no longer queued in any way the user
   * can act on, and a component that renders its shell around zero visible
   * rows defeats the `:empty` check the composer's strip relies on to
   * disappear: the shell itself was the "phantom sliver above the composer".
   */
  const inFlightIdSet = new Set(inFlightIds);
  const visibleMessages = messages.filter((m) => !inFlightIdSet.has(m.id));

  /**
   * What actually renders: the drag's local order while one is live, the
   * store's order otherwise. Rows that vanished mid-drag (drained, removed)
   * drop out; rows that appeared mid-drag (a retry re-queued) append at the
   * end rather than not rendering at all.
   */
  const byId = new Map(visibleMessages.map((m) => [m.id, m]));
  let orderedMessages = visibleMessages;
  if (dragOrder) {
    const dragOrderSet = new Set(dragOrder);
    const orderedIds = dragOrder.filter((id) => byId.has(id));
    for (const m of visibleMessages) {
      if (!dragOrderSet.has(m.id)) orderedIds.push(m.id);
    }
    orderedMessages = orderedIds.map((id) => byId.get(id)!);
  }

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

  /**
   * The one place a reorder reaches the store, shared by drag and keyboard.
   * `targetSlot` is a position in the PRE-move visible list; the mapping to
   * the store's pending coordinates lives in `reorderToPendingIndex`.
   */
  const commitMove = useCallback(
    (id: string, targetSlot: number) => {
      const toIndex = reorderToPendingIndex(
        visibleMessages.map((m) => m.id),
        messages.map((m) => m.id),
        id,
        targetSlot,
      );
      if (toIndex === null) return false;
      onReorder?.(id, toIndex);
      setMoveAnnouncement(`Moved to position ${targetSlot + 1} of ${visibleMessages.length}`);
      return true;
    },
    [visibleMessages, messages, onReorder],
  );

  /**
   * Keyboard path, from the drag handle. React reorders keyed rows with
   * `insertBefore`, and a focused element that is detached and reattached
   * loses focus to `<body>` — so after the move, focus is restored to the
   * moved row's handle. That is what lets Arrow-Arrow-Arrow walk a row to
   * the top.
   */
  const moveStep = useCallback(
    (id: string, direction: 'up' | 'down') => {
      const index = visibleMessages.findIndex((m) => m.id === id);
      const target = reorderTargetIndex(index, direction, visibleMessages.length, 0);
      if (target === null) return;
      if (!commitMove(id, target)) return;
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(
          `[data-queued-id="${CSS.escape(id)}"]`,
        );
        row?.querySelector<HTMLElement>('[data-drag-handle]')?.focus();
      });
    },
    [visibleMessages, commitMove],
  );

  const handleDragReorder = useCallback((ids: string[]) => {
    dragOrderRef.current = ids;
    setDragOrder(ids);
  }, []);

  /**
   * Pointer path. A drag that never crossed a row leaves the ref `null` and
   * commits nothing. The store dispatch is synchronous, so clearing the local
   * order in the same handler re-renders once, straight into the new order —
   * no snap-back frame.
   */
  const handleDragCommit = useCallback(
    (id: string) => {
      const finalOrder = dragOrderRef.current;
      dragOrderRef.current = null;
      setDragOrder(null);
      if (!finalOrder) return;
      commitMove(id, finalOrder.indexOf(id));
    },
    [commitMove],
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

      {/* Separate region: a move does not change the count, so the summary
          above never re-announces — without this, a reorder is silent. */}
      <p className="sr-only" aria-live="polite">
        {moveAnnouncement}
      </p>

      {/* ONE list. Failures are rows in the queue that need attention, not a
          second queue below it. The cap keeps a long queue from pushing the
          textarea off screen — it scrolls inside itself, and FadedScrollArea
          fades whichever edge has more rows beyond it, so a clipped row reads
          as "scroll", not as a rendering fault. The strip is `bg-sidebar`, so
          the default `from-sidebar` fade matches by construction. */}
      <FadedScrollArea
        rootClassName="w-full"
        className={cn('max-h-40', orderedMessages.length > 4 ? 'from-sidebar' : 'from-transparent')}
      >
        <Reorder.Group
          axis="y"
          values={orderedMessages.map((m) => m.id)}
          onReorder={handleDragReorder}
          ref={listRef}
          className={cn('w-full', paused && 'opacity-60')}
        >
          {orderedMessages.map((message) => (
            <QueuedRow
              key={message.id}
              message={message}
              onRemove={onRemove}
              onEdit={onEdit}
              draggable={Boolean(onReorder) && visibleMessages.length > 1}
              onMoveStep={moveStep}
              onDragCommit={handleDragCommit}
              onSendNow={paused ? onSendNow : undefined}
              sendNowLabel={isRunning ? 'Send now — stops the current turn' : 'Send now'}
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
        </Reorder.Group>
      </FadedScrollArea>
    </>
  );
}
