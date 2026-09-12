'use client';

/**
 * The queue, shown as a flat list of what goes next — one borderless row per
 * message, drag handle on the left, actions on the right.
 *
 * All of it sends when this turn ends, as one message, top to bottom. The
 * order is therefore the content — the batch is composed in list order, so
 * moving a row edits what the sent message says, which is why the order gets
 * a control.
 *
 * ## The header
 *
 * One line above the rows, and the only place that says WHY the queue is not
 * moving. Its words and its one action both come from `queue-gates.ts`
 * (`queueHeaderLabel`, `queueHeaderAction`) rather than being assembled here:
 * a header that says "runs after this turn" over a queue the user just
 * stopped is the stale-header bug those two functions share a ranking to
 * prevent, and a second copy of the ranking in JSX brings it straight back.
 *
 * The header is also the collapse toggle. A queue deep enough to open
 * collapsed (`queueStartsCollapsed`) would otherwise push the textarea down
 * the screen at the exact moment the user is typing into it.
 *
 * ## The row anatomy
 *
 *   - **A position number**, 1-based over every row on screen. The list
 *     scrolls inside its own box, so a row can sit above or below the fold
 *     where "third from the top" is not something the user can count — and a
 *     queue that is reordered by dragging needs a way to say which row you
 *     mean. A **parked** row shows a pin there instead: it is held out of the
 *     drain, so its number would promise a turn it is not waiting for.
 *   - **"Runs next"** on the first row that is neither parked nor already on
 *     the wire — the one the drain actually takes. It is a marker, not a
 *     control: the whole point of an ordered list is knowing what the order
 *     currently means, and before this the answer was "the top row, unless it
 *     is one of the ones you cannot see the state of".
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

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  DotsSixVerticalIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { Reorder, useDragControls, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  QUEUE_FULL_HINT_KEY,
  queueHeaderAction,
  queueHeaderLabelKey,
  queueIsAtCap,
  queueStartsCollapsed,
  type QueueRunState,
} from './queue-gates';
import {
  QUEUE_GROWTH_ANNOUNCEMENT_KEY,
  QUEUE_MOVE_ANNOUNCEMENT_KEY,
  canMoveToTop,
  duplicateBlockedHintKey,
  nextFocusAfterRemove,
  queueGrowthDepth,
  reorderTargetIndex,
  reorderToPendingIndex,
  runsNextId,
} from './queued-messages-logic';
import { useTranslations } from '@/i18n/use-translations';

/** Structural, so callers do not have to import the store's types. */
export interface QueuedMessageView {
  id: string;
  text: string;
  /**
   * How many files this row carries — names only, never bytes, and only ever
   * a count here.
   *
   * The list does not draw them. It exists so `canDuplicateRow` can refuse a
   * copy that would silently drop them: the parts live only in the
   * `DELETE .../prompts/:id` response, so a duplicate built from a listed row
   * carries the words and none of the files.
   */
  attachmentCount?: number;
  /** Present on a message in the failed list. */
  lastError?: string;
  /**
   * Held out of the drain — it stays in the list until the user sends it.
   *
   * Renders a pin where the position number goes and is never the row marked
   * "Runs next", because the drain steps over it.
   */
  parked?: boolean;
}

export interface QueuedMessagesProps {
  messages: QueuedMessageView[];
  failed?: QueuedMessageView[];
  /**
   * Which of `messages` are on the wire, oldest first.
   *
   * They RENDER, and they render inert: no edit, no remove, no send-now, no
   * drag handle. A forwarded prompt sits at OpenCode behind the turn in front
   * of it — minutes, sometimes an hour — with nothing else on screen holding
   * it, so hiding it is the message disappearing; and every action the strip
   * offers is refused by the server for a row it has already forwarded.
   */
  inFlightIds?: string[];
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  /**
   * Move a message to `toIndex` — a position in `messages` as passed in,
   * in-flight rows included, matching the store's pending array. The drag
   * handle computes that index itself; see `reorderToPendingIndex`.
   */
  /**
   * The new order, top first — every row this list renders, not a moved id and
   * an index.
   *
   * The queue is a set of durable SERVER rows now, and the server rewrites its
   * one ordering key (`clientSentAtMs`) from whatever order it is handed. A
   * full order is the only form that cannot be misread halfway: an index means
   * nothing without both sides first agreeing which rows are in the list and
   * which of them are already on the wire. (The previous shape targeted a
   * browser array, where the index WAS the position.)
   */
  onReorder?: (orderedIds: string[]) => void;
  onRetry?: (id: string) => void;
  /**
   * A turn is running. Changes what the promote action is CALLED — see
   * `sendNowLabel` at the call site. Nothing about it interrupts anything.
   */
  isRunning?: boolean;
  /**
   * Start expanded. The queue opens collapsed — one line showing the prompt
   * that goes next — so parking a prompt never pushes the composer down while
   * you are typing in it. A host that owns more vertical room can open it.
   */
  defaultOpen?: boolean;
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
  /** Send this message now — stopping the current turn first if one is running. */
  onSendNow?: (id: string) => void;
  /**
   * What the turn underneath is doing. Feeds `queueHeaderLabel` and
   * `queueHeaderAction` — it decides the header's words, nothing else.
   */
  runState?: QueueRunState;
  /** Release a queue held by `paused`. Rendered only when the header asks for it. */
  onResume?: () => void;
  /**
   * Retry the whole queue after a failed run — NOT `onRetry`, which re-sends
   * one row out of `failed`. Two different actions with two different scopes;
   * folding them into one prop is how the header's Retry ends up re-sending a
   * single unrelated message.
   */
  onRetryQueue?: () => void;
  /** Copy a row into a new queued row at the end of the list. */
  onDuplicate?: (id: string) => void;
  /**
   * Promote a row to the top. Receives the id only — the HOST owns the order
   * and computes it with `nextQueueOrderAfterMoveToTop`, the same function
   * this list asks whether to offer the action at all.
   */
  onMoveToTop?: (id: string) => void;
}

/**
 * The line above the rows: what the queue is doing, the one thing to do about
 * it, and the collapse toggle.
 *
 * Every word comes from `queue-gates.ts`. The label and the action are two
 * faces of one ranking (`queueDrainBlockedReason`), and rebuilding either from
 * `paused`/`runState` here would let them disagree — a Resume button under a
 * header reading "runs after this turn" is the failure that ranking exists to
 * stop.
 *
 * The action button renders only when the host actually wired the handler:
 * a Resume that does nothing is worse than a queue with no visible way out,
 * because the user stops looking for one.
 */
function QueueHeader({
  depth,
  firstText,
  paused,
  collapsed,
  listId,
  onToggle,
  onResume,
  onRetryQueue,
  runState,
}: {
  depth: number;
  /** The text of queue[0] — what the collapsed row shows. */
  firstText: string;
  paused: boolean;
  collapsed: boolean;
  listId: string;
  onToggle: () => void;
  onResume?: () => void;
  onRetryQueue?: () => void;
  runState: QueueRunState;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const action = queueHeaderAction({ runState, paused });
  const onAction = action === 'resume' ? onResume : action === 'retry' ? onRetryQueue : undefined;

  return (
    <div className="flex w-full items-center gap-2 px-1.5 pt-1">
      {/* THE NEXT MESSAGE, not a count of them.
          This line read "3 queued · runs after this turn" — a sentence about
          the queue that never said what was IN it. Collapsed, the one thing
          worth showing is the prompt that goes next; the count is a number
          beside it, and the rest is one click away. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={listId}
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left',
          'text-muted-foreground hover:text-foreground transition-colors',
        )}
      >
        {/* TWO GLYPHS, not one that rotates. This line is on screen the whole
            time a queue exists, and a spinning caret is motion nobody asked to
            watch again. */}
        {collapsed ? (
          <CaretRightIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <CaretDownIcon aria-hidden className="size-3 shrink-0" />
        )}
        <span className="truncate text-xs">{firstText}</span>
        {depth > 1 && (
          <span className="shrink-0 text-xs tabular-nums opacity-70">{depth}</span>
        )}
        {/* The state, only when it is not the ordinary one — a queue that is
            simply waiting its turn needs no caption. */}
        {(paused || runState === 'error' || runState === 'awaiting_input') && (
          <span className="shrink-0 truncate text-xs">
            {t(queueHeaderLabelKey({ runState, paused }), { count: depth })}
          </span>
        )}
      </button>

      {queueIsAtCap(depth) && (
        <span className="text-muted-foreground shrink-0 text-xs">
          {t.raw(QUEUE_FULL_HINT_KEY)}
        </span>
      )}

      {action && onAction && (
        <button
          type="button"
          onClick={onAction}
          className={cn(
            'shrink-0 cursor-pointer rounded-sm px-1 text-xs',
            'text-muted-foreground hover:text-foreground transition-colors',
          )}
        >
          {action === 'resume' ? t.raw('textd640c7421da0') : t.raw('text942087cc2d41')}
        </button>
      )}
    </div>
  );
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
  position,
  runsNext = false,
  promotable = false,
  inFlight = false,
  onRemove,
  onEdit,
  draggable,
  onMoveStep,
  onDragCommit,
  onSendNow,
  onDuplicate,
  onMoveToTop,
  duplicateHintKey = null,
  sendNowLabelKey = 'text588032878324',
  onFocusSibling,
}: {
  message: QueuedMessageView;
  /** 1-based place in the list as rendered — parked and in-flight rows counted. */
  position: number;
  /** This is the row the drain takes next. At most one row in the list has it. */
  runsNext?: boolean;
  /** `canMoveToTop` said yes — the row is not already at the top. */
  promotable?: boolean;
  /** On the wire at OpenCode: rendered, dimmed, and out of the user's hands. */
  inFlight?: boolean;
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
  onDuplicate?: (id: string) => void;
  onMoveToTop?: (id: string) => void;
  /**
   * Why Duplicate is refused for this row, or `null` when it is offered —
   * `duplicateBlockedHintKey`. Non-null disables the item AND names the
   * sentence shown on it, because a disabled row that says nothing about why
   * reads as a broken menu. A CATALOG KEY, not the sentence: this list ships in
   * nine locales.
   */
  duplicateHintKey?: string | null;
  /** Catalog key for the promote action's name — 'Send now' or 'Run next'. */
  sendNowLabelKey?: string;
  onFocusSibling: (id: string | null) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [dragging, setDragging] = useState(false);
  const hasActions = Boolean(onEdit || onSendNow || onDuplicate || onMoveToTop || onRemove);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragControls = useDragControls();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // CARET AT THE END, not `select()`. Selecting the whole line paints a
    // highlight block and no visible caret, so the row read as "selected"
    // rather than "you are typing in this" — and the next keystroke silently
    // replaced the whole message. A caret after the last character blinks,
    // which is the one unmistakable signal that a field is live.
    const end = input.value.length;
    input.setSelectionRange(end, end);
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
      aria-busy={inFlight || undefined}
      className={cn(
        'group/queued flex items-center gap-2 rounded-md px-1.5 py-1',
        'hover:bg-muted-foreground/[0.06]',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        // Lifted row: opaque over its siblings, one hairline of elevation.
        dragging && 'bg-popover relative z-10 shadow-xs',
      )}
    >
      {/* WHILE EDITING the leading glyph is a pencil, not a grab handle.
          The row is not reorderable mid-edit (dragging it would blur the input
          and commit), so a grab handle there advertises something that cannot
          happen — and the pencil is the second half of the "this row is live"
          signal the caret starts. */}
      {/* ONE LEADING SLOT, empty until you hover.
          It used to hold a queue glyph OR a drag handle, and then a position
          number OR a pin — two glyph columns in front of a line of text that is
          usually shorter than they are. The order of the list IS the position,
          and every row in this list is parked, so a pin on all of them says
          nothing. Width is reserved so the text does not shift when the handle
          fades in. The position is still spoken: a screen reader cannot see the
          list to count it. */}
      <span className="flex w-4 shrink-0 items-center justify-center">
        {draggable && !editing ? (
          <button
            type="button"
            aria-label={t.raw('text66f1eea2412e')}
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
              'text-muted-foreground/60 hover:text-foreground flex size-4 touch-none items-center justify-center rounded-sm',
              'opacity-0 transition-[color,opacity] group-hover/queued:opacity-100 focus-visible:opacity-100',
              dragging ? 'cursor-grabbing opacity-100' : 'cursor-grab',
            )}
          >
            <DotsSixVerticalIcon aria-hidden className="size-3.5" />
          </button>
        ) : null}
        <span className="sr-only">{t('text0d2e397de6ff', { position })}</span>
      </span>

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
          aria-label={t.raw('text250ac6f7d30f')}
          className="text-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={!onEdit}
          onClick={() => setEditing(true)}
          className={cn(
            'min-w-0 flex-1 cursor-text truncate text-left text-xs disabled:cursor-default',
            // Tokens, not opacity: an in-flight row is muted, a waiting row is
            // ordinary body text. The dim that says "not sent yet" belongs to
            // the whole strip, not to this string.
            inFlight ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {message.text}
        </button>
      )}

      {/* THE ONE ROW THE DRAIN TAKES NEXT, said in words. Hidden while the row
          is being edited so the input keeps the full width of the row.
          `runsNextId` already refuses to mark a parked or in-flight row, so
          this never contradicts the pin beside it. */}
      {runsNext && !editing && (
        <span className="text-muted-foreground shrink-0 text-xs">
          {t.raw('texte26d39e7b323')}
        </span>
      )}

      {/* ONE trailing control, not three.
          Three icons side by side on a 28px row is most of the row's width
          spent on chrome, and it read as clutter next to the drag handle — so
          the row's actions live behind a single horizontal ⋯ menu. The menu
          also gives every action a NAME: the icons were a paper plane, a
          pencil and a bin, and "send this one now, ahead of the others" is not
          something a paper plane says on its own.
          Nothing here for an in-flight row — the server refuses all three. */}
      {/* THREE ACTIONS, INLINE, ON HOVER — no ⋯ menu.
          The menu hid the two things people actually do (run this one next,
          take it back out) behind a click, on a row whose whole job is to be
          glanceable. Menus earn their place when a row has many actions or
          rare ones; this row has three and two of them are one-word verbs.
          Duplicate and Move-to-top went with the menu: dragging IS move-to-top,
          and Duplicate was disabled on any row it could not copy faithfully,
          which is most of the long ones.
          Hover-revealed, but always in the DOM and reachable by Tab, so the
          keyboard path does not depend on a pointer. */}
      {hasActions && !editing && (
        <span
          className={cn(
            'flex shrink-0 items-center gap-0.5',
            'opacity-0 transition-opacity group-hover/queued:opacity-100 focus-within:opacity-100',
          )}
        >
          {onSendNow && (
            <RowAction label={t.raw(sendNowLabelKey)} onClick={() => onSendNow(message.id)}>
              <PaperPlaneRightIcon aria-hidden className="size-3.5" />
            </RowAction>
          )}
          {onEdit && (
            <RowAction label={t.raw('text464c4ffd019e')} onClick={() => setEditing(true)}>
              <PencilSimpleIcon aria-hidden className="size-3.5" />
            </RowAction>
          )}
          {onRemove && (
            <RowAction
              label={t.raw('textc0b9d9e9ac1d')}
              onClick={() => {
                onFocusSibling(message.id);
                onRemove(message.id);
              }}
            >
              <TrashIcon aria-hidden className="size-3.5" />
            </RowAction>
          )}
        </span>
      )}
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
  defaultOpen = false,
  onSendNow,
  runState = 'idle',
  onResume,
  onRetryQueue,
  onDuplicate,
  onMoveToTop,
}: QueuedMessagesProps) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  /**
   * DECIDED ONCE, at mount, from the depth the list opened with.
   *
   * Not derived from the current depth every render: a list that shuts itself
   * the moment the fourth row lands would collapse under the user mid-burst,
   * which is exactly when they are watching what they parked. A queue that was
   * already deep when the page loaded is the case `queueStartsCollapsed`
   * exists for, and that is the one this reads.
   */
  const [collapsed, setCollapsed] = useState(() => !defaultOpen && queueStartsCollapsed(messages.length));
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
   * In-flight rows used to be filtered HERE, before any render decision. That
   * was right while "on the wire" meant milliseconds — the row left the queue
   * and arrived in the transcript. It no longer does: a prompt typed mid-turn
   * is forwarded at once and stays `delivering` until the turn in front of it
   * ends, with no transcript bubble in the meantime. Filtering it out is the
   * user's message disappearing for the length of a turn.
   *
   * So every row renders, and the set below decides which ones render inert.
   * The `:empty` check the composer's strip relies on to disappear still holds:
   * with no rows at all, nothing here renders.
   */
  const inFlightIdSet = new Set(inFlightIds);
  const visibleMessages = messages;

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
   * "Message queued, position N of M" — into the SAME live region as the move
   * announcement, deliberately. Two polite regions updated in one frame race
   * each other and screen readers drop one of them, so the queue speaks with
   * one voice: whatever changed last is what it says.
   *
   * The ref starts at the mount depth, so a page that loads with rows already
   * queued does not announce them as news.
   */
  const previousDepthRef = useRef(visibleMessages.length);
  useEffect(() => {
    const previousDepth = previousDepthRef.current;
    previousDepthRef.current = visibleMessages.length;
    const grewTo = queueGrowthDepth(previousDepth, visibleMessages.length);
    if (grewTo !== null) {
      setMoveAnnouncement(t(QUEUE_GROWTH_ANNOUNCEMENT_KEY, { position: grewTo, total: grewTo }));
    }
  }, [visibleMessages.length, t]);

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
      // Splice out, then splice in — exactly the move `reorderToPendingIndex`
      // computes its target for, so the occupant's PRE-move index lands the
      // dragged row on the correct side of it in either direction.
      const orderedIds = messages.map((m) => m.id);
      const from = orderedIds.indexOf(id);
      if (from === -1) return false;
      orderedIds.splice(from, 1);
      orderedIds.splice(toIndex, 0, id);
      onReorder?.(orderedIds);
      setMoveAnnouncement(
        t(QUEUE_MOVE_ANNOUNCEMENT_KEY, {
          position: targetSlot + 1,
          total: visibleMessages.length,
        }),
      );
      return true;
    },
    [visibleMessages, messages, onReorder, t],
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
      // `minIndex: 0` — every rendered row is a movable slot. In-flight rows
      // are drawn in place rather than pinned to the head (`inFlightIds`), so
      // there is no leading batch to step over. See `reorderTargetIndex`.
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

  /**
   * Read off the RENDERED order, not the store's. During a drag the visual
   * order is the one the user is reasoning about, so "Runs next" has to follow
   * the row under their finger — a marker that stays behind on the old top row
   * says the drop will do something other than what it will do.
   */
  const orderedIds = orderedMessages.map((m) => m.id);
  // NOTHING RUNS NEXT WHILE THE QUEUE IS HELD. The header says "paused" and a
  // row saying "Runs next" underneath it says the opposite — the marker is a
  // statement about what happens when this turn ends, and while paused the
  // answer is "nothing does". It comes back on resume, on whichever row is
  // first then.
  const runsNextRowId = paused ? null : runsNextId(orderedMessages, inFlightIds);

  return (
    <>
      {/* Announced politely: a queue that grows or drains while you are typing
          is a change screen-reader users otherwise have no way to notice.

          THE SAME STRING THE HEADER SHOWS, from the same function. This region
          used to have wording of its own ("N queued · all send when this turn
          ends"), written before the list knew about `runState` — so the moment
          a run failed, a sighted user read "last run failed" and a
          screen-reader user heard "all send when this turn ends", at the same
          instant, about the same queue. Two surfaces stating opposite facts is
          exactly what `queueHeaderLabel` exists to prevent; it is the only
          source either surface reads now. */}
      <p className="sr-only" aria-live="polite">
        {t(queueHeaderLabelKey({ runState, paused }), { count: visibleMessages.length })}
      </p>

      {/* Separate region: a move does not change the count, so the summary
          above never re-announces — without this, a reorder is silent. */}
      <p className="sr-only" aria-live="polite">
        {moveAnnouncement}
      </p>

      {visibleMessages.length > 0 && (
        <QueueHeader
          depth={visibleMessages.length}
          firstText={visibleMessages[0]?.text ?? ''}
          runState={runState}
          paused={paused}
          collapsed={collapsed}
          listId={listId}
          onToggle={() => setCollapsed((open) => !open)}
          onResume={onResume}
          onRetryQueue={onRetryQueue}
        />
      )}

      {/* ONE list. Failures are rows in the queue that need attention, not a
          second queue below it. The cap keeps a long queue from pushing the
          textarea off screen — it scrolls inside itself.

          Rendered even while collapsed, empty: `aria-controls` on the header
          has to point at an element that exists, and a failed row is shown
          regardless — a failure hidden behind a collapse is a message the user
          believes was sent. */}
      {/* A REAL SCROLLBAR, not a fade.
          The list was a faded scroll area with `scrollbar-hide`, so a queue
          longer than the box gave no handle to grab and no sign of how much
          was below. `scrollbar-minimal` is the house thin scrollbar; the box
          is capped so a long queue cannot push the composer off screen. */}
      <div
        className={cn(
          'scrollbar-minimal w-full overflow-y-auto',
          collapsed ? 'max-h-0' : 'max-h-52',
        )}
      >
        <Reorder.Group
          axis="y"
          id={listId}
          values={collapsed ? [] : orderedMessages.map((m) => m.id)}
          onReorder={handleDragReorder}
          ref={listRef}
          className={cn('w-full', paused && 'opacity-60')}
        >
          {(collapsed ? [] : orderedMessages).map((message, index) => {
            // A row on the wire keeps its text and loses every control: the
            // server refuses remove (409), retry (404) and reorder on a prompt
            // OpenCode already holds, and a control that always fails is worse
            // than no control.
            const inFlight = inFlightIdSet.has(message.id);
            return (
              <QueuedRow
                key={message.id}
                message={message}
                // The place in the list the user is looking at, so it matches
                // what they would count — not a place in the drain order,
                // which parked rows are not part of at all.
                position={index + 1}
                runsNext={message.id === runsNextRowId}
                promotable={canMoveToTop(orderedIds, message.id)}
                inFlight={inFlight}
                onRemove={inFlight ? undefined : onRemove}
                onEdit={inFlight ? undefined : onEdit}
                draggable={Boolean(onReorder) && visibleMessages.length > 1 && !inFlight}
                onMoveStep={moveStep}
                onDragCommit={handleDragCommit}
                // ALWAYS OFFERED, not only while the queue is paused. "Run
                // this one next" is the whole point of an ordered list you can
                // rearrange, and gating it on the hold meant the only way to
                // promote a message was to stop the agent first. The label
                // says what it costs when a turn is running.
                onSendNow={inFlight ? undefined : onSendNow}
                // Stripped from an in-flight row with everything else: the
                // server refuses a reorder on a prompt OpenCode already holds,
                // and Duplicate on a row that is already gone is a second copy
                // of a message the user cannot see the first of.
                onDuplicate={inFlight ? undefined : onDuplicate}
                onMoveToTop={inFlight ? undefined : onMoveToTop}
                duplicateHintKey={duplicateBlockedHintKey(
                  message,
                  queueIsAtCap(visibleMessages.length),
                )}
                // TWO LABELS FOR TWO STATES, because the action means two
                // different things and one word cannot carry both.
                //
                // Idle: the row goes out now — "Send now" is literally true.
                // Running: it does NOT go out now. It moves to the head of the
                // line and leaves when the current answer finishes, so "Send
                // now" would be a promise the queue cannot keep; "Run next" is
                // what actually happens.
                //
                // Neither wording threatens the turn. An earlier version read
                // "— stops the current turn", accurate then because the handler
                // aborted the run. It no longer does.
                sendNowLabelKey={isRunning ? 'textbf420a4559e3' : 'text588032878324'}
                onFocusSibling={(id) => id && focusAfterRemove(id)}
              />
            );
          })}

          {failed.map((message) => (
            <li key={message.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1">
              <WarningIcon weight="fill" className="text-kortix-red size-3.5 shrink-0" />
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {message.text}
              </span>
              {message.lastError && (
                <Hint label={message.lastError} side="top">
                  <span className="text-kortix-red shrink-0 text-xs">
                    {t.raw('text031a8f0f659d')}
                  </span>
                </Hint>
              )}
              {onRetry && (
                <RowAction label={t.raw('text942087cc2d41')} onClick={() => onRetry(message.id)}>
                  <ArrowClockwiseIcon className="size-3.5" />
                </RowAction>
              )}
              {onRemove && (
                <RowAction label={t.raw('text48845bff334a')} onClick={() => onRemove(message.id)}>
                  <TrashIcon className="size-3.5" />
                </RowAction>
              )}
            </li>
          ))}
        </Reorder.Group>
      </div>
    </>
  );
}
