'use client';

import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import Loading from '../../components/ui/loading';
import { SESSION_NOTICE } from '@kortix/sdk';
import { MoonIcon } from '@phosphor-icons/react';

import { COMPOSER_INPUT_SLOT_CLASS, type SessionChatInputProps } from './composer';
import type { ComposerQuote } from './composer-logic';
import { QuoteList } from './quote-list';

/**
 * A full-width bar between a docked question and the card (the notice). The
 * question, this bar, and the card read as one surface: square top, and the
 * side segments of the ring the question starts and the card ends. The clip
 * keeps only the side ring, so no ring line crosses a seam.
 */
const DOCKED_MIDDLE_LAYER_CLASS =
  'ring-muted/15 rounded-t-none ring-3 [clip-path:inset(0_-8px_0_-8px)]';

/**
 * The composer's stack ABOVE the card: the `'above'` `/` dock anchor, the
 * reply-quote card, then the queue strip and the "still waking" notice.
 * `ComposerImpl` owns the state and effects and passes them in; this renders
 * exactly the subtree `ComposerImpl` used to inline (KRTX-373 phase 1).
 */
export interface ComposerAboveCardDerived {
  /** Shared `/` dock anchor id: the `'above'` anchor renders here, the
   *  `'below'` one in `ComposerCard`, and the editor targets the id. */
  dockId: string;
  quotes: ComposerQuote[];
  quoteListLabels: { count: string; expand: string; collapse: string; remove: string };
  handleRemoveQuote: (id: string) => void;
}

export type ComposerAboveCardProps = SessionChatInputProps & ComposerAboveCardDerived;

export function ComposerAboveCard({
  dockId,
  quotes,
  quoteListLabels,
  handleRemoveQuote,
  aboveSlot,
  inputSlot,
  notice = null,
  onNoticeRetry,
  onModelChange,
  slashMenuPlacement = 'above',
  questionActive = false,
}: ComposerAboveCardProps) {
  const showQueueStrip = Boolean(inputSlot);

  return (
    <>
    {/*
      The "still waking" notice. Above the card, in flow, so it pushes the
      composer down rather than covering anything — the same reasoning as the
      `/` dock below it.

      This replaces disabling the input. A stopped sandbox does not clear on
      its own, so the old treatment (dead editor, spinner where the send
      button belongs, no text) was indistinguishable from a broken composer.
      The input stays live; the submit becomes a durable inbox row and the
      control plane delivers it when the box answers, so nothing is lost by
      letting people type.

      `role="status"` + `aria-live="polite"`: this appears without the user
      doing anything, and it changes what the send button will DO. A screen
      reader that never announces it leaves exactly the confusion this bar
      exists to remove.
    */}
    {slashMenuPlacement === 'above' && <div id={dockId} />}

    {/*
      The reply quotes, as their own card above everything else in the
      stack — the queued-messages card's chrome and mount. `QuoteList`
      renders nothing for an empty list, and `empty:hidden` then drops this
      wrapper and its margin.
    */}
    <div className="mb-2 w-full empty:hidden">
      {/* Keyed on emptiness: an emptied card remounts, so the next quote
          always opens it expanded, whatever the user collapsed last time. */}
      <QuoteList
        key={quotes.length === 0 ? 'empty' : 'quotes'}
        quotes={quotes}
        labels={quoteListLabels}
        onRemove={handleRemoveQuote}
      />
    </div>

    {/* The queued messages: their own card, under the reply quotes. */}
    {aboveSlot && <div className="mb-2 w-full empty:hidden">{aboveSlot}</div>}

    {/*
      The stack above the card. Every layer is full width (the queue strip,
      the notice, the card), so the stack reads as one surface: the topmost
      visible layer rounds its top, every layer under it is square and its
      top border is the divider. A narrower strip exposed the corners of the
      layer under it and is not allowed (`composer-above-card.test.tsx` pins
      `w-full`).

      Whether the strip is visible is known only to CSS (`:empty`, see
      below), so "square under a visible strip" is a sibling selector on
      this wrapper. `ComposerCard` applies the same rule to the card
      through `data-composer-stack`.
    */}
    {(notice || showQueueStrip) && (
      <div
        data-composer-stack
        className="relative isolate flex w-full flex-col items-center justify-center [&>[data-composer-strip]:not(:empty)~*]:rounded-t-none"
      >
        {/*
          ONE element carries both the strip's chrome (bg, border, padding)
          AND `empty:hidden`. `inputSlot` is a fragment whose children all
          self-hide, so it is ALWAYS a truthy ReactNode — no JS condition can
          know whether it rendered anything. Only CSS `:empty` can, and it
          only works on the element that owns the visible chrome: the old
          two-div version hid an inner wrapper while the padded, bordered
          shell around it kept painting as an empty sliver.
        */}
        {showQueueStrip && (
          // A pending question also carries a ring around the whole
          // surface, down to the card: each layer clips its ring at the seam.
          <div
            data-composer-strip
            className={cn(
              COMPOSER_INPUT_SLOT_CLASS,
              questionActive &&
                'bg-background ring-muted/15 ring-3 [clip-path:inset(-8px_-8px_0_-8px)]',
            )}
          >
            {inputSlot}
          </div>
        )}

        {notice && (
          <div
            role="status"
            aria-live="polite"
            // Rounded when topmost; square under a visible strip (the
            // wrapper's sibling rule). Under a docked question it also
            // carries the side ring.
            className={cn(
              'bg-sidebar border-border flex w-full items-center gap-2 rounded-t-xl border border-b-0 px-3 py-1.5',
              questionActive && DOCKED_MIDDLE_LAYER_CLASS,
            )}
          >
            {notice === SESSION_NOTICE.idle ? (
              <MoonIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Loading className="size-3.5 shrink-0" />
            )}
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {notice}
            </span>
            {onNoticeRetry && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground h-auto shrink-0 px-1.5 py-0.5 text-xs"
                onClick={onNoticeRetry}
              >
                {'Retry'}
              </Button>
            )}
          </div>
        )}

      </div>
    )}
    </>
  );
}
