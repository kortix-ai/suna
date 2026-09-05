'use client';

/**
 * Prompts that are queued at the server but not yet in the transcript, drawn
 * IN the transcript — as the user bubbles they are about to become.
 *
 * Every prompt THIS tab sends is painted into the transcript on Enter, under
 * the same wire id its inbox row carries (`session-chat.tsx` `handleSend`), so
 * its row is never drawn here — the transcript bubble is the one element the
 * prompt has for its whole life, and only its opacity changes. What this list
 * renders is the rest: rows this tab did not paint (sent from another device
 * or tab, or present after a reload) — until the runtime echoes them, at which
 * point the transcript takes over under the row's `message_id`.
 *
 * `QueuedPromptControls` is the shared status + actions row: remove; send now
 * while the queue is HELD by a stop (the only way out of a hold — otherwise a
 * stopped queue is indistinguishable from a broken one); retry on a failed
 * row. The transcript's own pending bubble renders the same controls in its
 * hover meta row (`SessionTurn` → `UserMessageActions` via `leadingActions`).
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  PaperPlaneRightIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  type AttachmentUploadStatus,
  BUBBLE_SURFACE,
  BUBBLE_TEXT,
  MessageAttachments,
  type NormalizedAttachment,
} from './user-message';

export interface QueuedPromptRow {
  id: string;
  text: string;
  /** Present on a failed row. */
  lastError?: string;
  /**
   * The row's files, by NAME and TYPE. A queued row is the only thing on
   * screen for a prompt whose bytes are still travelling to the box, and on a
   * warm box that is the whole upload window: drawn text-only, a send of
   * three files read as a send of none (2026-09-04, browser-measured).
   */
  attachments?: ReadonlyArray<{ filename: string; mime: string }>;
  /** What the strip says about them — see `AttachmentUploadStatus`. */
  uploadStatus?: AttachmentUploadStatus;
}

/** The dim a scheduled bubble sits at. One number, so the transcript's
 *  pending turn (`SessionTurn`) and this list agree. */
export const QUEUED_BUBBLE_OPACITY_CLASS = 'opacity-50';

/** `interrupted`: the runtime holds the message but a Stop ended the turn
 *  before a step opened under it — it runs with the next send. */
export type QueuedPromptState = 'queued' | 'in-flight' | 'held' | 'failed' | 'interrupted';

export function queuedPromptStatusLabel(state: QueuedPromptState, lastError?: string): string {
  switch (state) {
    case 'in-flight':
      // Handed to the runtime, waiting for the next step: from the user's
      // side that is still "queued" — the difference is which of our servers
      // holds it, and that is not theirs to track.
      return 'Queued';
    case 'held':
      return 'Held — stopped';
    case 'failed':
      return lastError ? `Not sent — ${lastError}` : 'Not sent';
    case 'interrupted':
      return 'Queued — runs with your next message';
    default:
      return 'Queued';
  }
}

function Action({
  label,
  onClick,
  children,
  destructive,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Hint label={label} side="top" align="center">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={onClick}
        // 24px visible, 40px target — the queued-prompt row packs several of
        // these side by side.
        className={cn('hit-area-2', destructive && 'hover:text-destructive')}
      >
        {children}
      </Button>
    </Hint>
  );
}

/**
 * The one-word status of a queued prompt — "Queued", "Held — stopped", "Not
 * sent — …". ALWAYS visible: a bubble at 50% opacity with nothing said about
 * it reads as "something is wrong", and the word is what makes the dim legible
 * (Claude.ai/ChatGPT both caption a queued message). The controls beside it
 * stay hover-revealed — see `QueuedPromptActions`.
 */
export function QueuedPromptStatus({
  state,
  lastError,
}: {
  state: QueuedPromptState;
  lastError?: string;
}) {
  const failed = state === 'failed';
  // A plain queued/in-flight bubble says nothing: the dim IS the state, and a
  // caption under every queued message read as clutter (review feedback).
  // Held, failed and interrupted still speak — those need words to be
  // actionable.
  if (state === 'queued' || state === 'in-flight') return null;
  return (
    <InlineMeta>
      <span
        data-queued-status={state}
        className={cn('flex items-center gap-1', failed && 'text-destructive')}
      >
        {failed && <WarningIcon className="size-3.5" />}
        {queuedPromptStatusLabel(state, lastError)}
      </span>
    </InlineMeta>
  );
}

/**
 * The controls a queued prompt has: remove; send now while the queue is HELD
 * by a stop; retry on a failed row. Null when the row has none — on the wire
 * (the server refuses every action for it) or interrupted (the runtime holds
 * it; a button here only invited a duplicate).
 */
export function QueuedPromptActions({
  id,
  state,
  onRemove,
  onSendNow,
  onRetry,
}: {
  id: string;
  state: QueuedPromptState;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const failed = state === 'failed';
  const interrupted = state === 'interrupted';
  // In-flight is NOT beyond removal any more: the server cancels a forwarded
  // prompt the agent has not read (and answers 409 with the reason when a
  // step already owns it). Only an interrupted message keeps zero controls —
  // the runtime holds it and the next send runs it.
  const showActions =
    !interrupted &&
    (Boolean(onRemove) || (failed && !!onRetry) || (state === 'held' && !!onSendNow));
  if (!showActions) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {failed && onRetry && (
        <Action label="Retry" onClick={() => onRetry(id)}>
          <ArrowClockwiseIcon className="size-4" />
        </Action>
      )}
      {state === 'held' && onSendNow && (
        <Action label="Send now" onClick={() => onSendNow(id)}>
          <PaperPlaneRightIcon className="size-4" />
        </Action>
      )}
      {onRemove && <RemoveFromQueueButton id={id} onRemove={onRemove} />}
    </div>
  );
}

/**
 * The one way OUT of the queue. Transcript turns render this in
 * `UserMessageActions` (hover row, same home as send-now / retry / copy).
 * The standalone queued list still sits it in a reserved column beside the
 * bubble — that list has no timestamp/copy row to collide with.
 */
export function RemoveFromQueueButton({
  id,
  onRemove,
}: {
  id: string;
  onRemove: (id: string) => void;
}) {
  return (
    <Action label="Remove from queue" onClick={() => onRemove(id)} destructive>
      <XIcon className="size-4" />
    </Action>
  );
}

/**
 * Status + controls together, for a caller that lays out one row. A row on
 * the wire has no controls — the server refuses every action for it — and
 * says so.
 */
export function QueuedPromptControls({
  id,
  state,
  lastError,
  onRemove,
  onSendNow,
  onRetry,
}: {
  id: string;
  state: QueuedPromptState;
  lastError?: string;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  return (
    <>
      <QueuedPromptStatus state={state} lastError={lastError} />
      <QueuedPromptActions
        id={id}
        state={state}
        onRemove={onRemove}
        onSendNow={onSendNow}
        onRetry={onRetry}
      />
    </>
  );
}

export interface QueuedPromptBubblesProps {
  queued: QueuedPromptRow[];
  /**
   * `queued` (default) draws the rows dimmed — prompts the agent has not
   * reached. `live` draws them at full opacity: the first prompt's preview,
   * which the agent IS on while the transcript catches up.
   */
  emphasis?: 'queued' | 'live';
  failed?: QueuedPromptRow[];
  /** Rows the server already handed to OpenCode: rendered, inert. */
  inFlightIds?: ReadonlySet<string> | string[];
  /** The queue is held by a stop — reveals "send now". */
  held?: boolean;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onRetry?: (id: string) => void;
  className?: string;
}

function QueuedBubble({
  row,
  state,
  live = false,
  onRemove,
  onSendNow,
  onRetry,
}: {
  row: QueuedPromptRow;
  state: QueuedPromptState;
  live?: boolean;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const failed = state === 'failed';
  const queuedTiles: NormalizedAttachment[] = (row.attachments ?? []).map((file, index) => ({
    key: `queued:${row.id}:${index}:${file.filename}`,
    filename: file.filename,
    mime: file.mime,
    // No `src`/`path`: nothing to preview until the runtime holds the bytes.
    pending: true,
  }));
  return (
    <div
      data-queued-prompt-id={row.id}
      data-queued-state={state}
      className="group/queued ml-auto flex w-full max-w-[80%] flex-col items-end gap-1 self-end"
    >
      {/* Bubble + its controls in ONE row: the actions sit beside the bubble,
          to its right, revealed on hover — never floating in space. The
          column is width-reserved (`w-6`) so nothing shifts on hover. */}
      {/* The row's files, ABOVE the bubble exactly where the sent message will
          draw them, every tile pending: the bytes are still on their way. Same
          strip and the same "Uploading N files…" line the boot shell shows, so
          the warm-box path stops being the one path with no tiles. */}
      {queuedTiles.length > 0 && (
        <MessageAttachments attachments={queuedTiles} pending status={row.uploadStatus} />
      )}
      <div className="flex w-full items-center justify-end gap-1">
        <div
          className={cn(
            BUBBLE_SURFACE,
            'w-fit transition-opacity duration-500',
            failed ? 'opacity-90' : live ? 'opacity-100' : QUEUED_BUBBLE_OPACITY_CLASS,
          )}
        >
          <div className={cn('max-w-full min-w-0 max-h-[200px] overflow-hidden', BUBBLE_TEXT)}>
            {row.text}
          </div>
        </div>
        <div
          className={cn(
            'flex w-6 shrink-0 flex-col items-center justify-center transition-opacity duration-150',
            failed
              ? 'opacity-100'
              : 'opacity-0 group-hover/queued:opacity-100 focus-within:opacity-100',
          )}
        >
          <QueuedPromptActions
            id={row.id}
            state={state}
            onRemove={onRemove}
            onSendNow={onSendNow}
            onRetry={onRetry}
          />
        </div>
      </div>
      <div className="flex w-full items-center justify-end">
        <QueuedPromptStatus state={state} lastError={row.lastError} />
      </div>
    </div>
  );
}

export function QueuedPromptBubbles({
  queued,
  emphasis = 'queued',
  failed = [],
  inFlightIds,
  held = false,
  onRemove,
  onSendNow,
  onRetry,
  className,
}: QueuedPromptBubblesProps) {
  if (queued.length === 0 && failed.length === 0) return null;
  const inFlight = inFlightIds instanceof Set ? inFlightIds : new Set(inFlightIds ?? []);
  return (
    <div
      role="list"
      aria-label={held ? 'Queued prompts, held' : 'Queued prompts'}
      className={cn('flex flex-col gap-3', className)}
    >
      {queued.map((row) => (
        <QueuedBubble
          key={row.id}
          row={row}
          state={inFlight.has(row.id) ? 'in-flight' : held ? 'held' : 'queued'}
          live={emphasis === 'live'}
          onRemove={onRemove}
          onSendNow={onSendNow}
        />
      ))}
      {failed.map((row) => (
        <QueuedBubble key={row.id} row={row} state="failed" onRemove={onRemove} onRetry={onRetry} />
      ))}
    </div>
  );
}
