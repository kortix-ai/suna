'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CaretUpIcon, XIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import type { ComposerQuote } from './composer-logic';

/** The composer's own focus request — see `useComposerFocus`. */
function focusComposer(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('focus-session-textarea'));
}

/**
 * What a row's X does: remove that quote. A keyboard press (`detail === 0`)
 * also sends focus to the composer, because the focused button unmounts with
 * its row and focus would otherwise fall to `<body>`. A pointer press leaves
 * focus alone: on a touch device, focusing the editor opens the keyboard.
 */
export function quoteListRemove(
  event: { id: string; detail: number },
  deps: { onRemove: (id: string) => void; focusComposer: () => void },
): void {
  deps.onRemove(event.id);
  if (event.detail === 0) deps.focusComposer();
}

/**
 * The card's copy, translated by the host (`threads.quoteCount`,
 * `threads.expandQuotes`, `threads.collapseQuotes`, and
 * `hardcodedUi.componentsSessionSessionChatInput.removeQuoteAriaLabel`).
 * Passed in rather than read here so the card renders the same in any test
 * process, whatever another test file mocked the translation hook to.
 */
export interface QuoteListLabels {
  /** The header, e.g. "3 Quotes". */
  count: string;
  expand: string;
  collapse: string;
  /** The row X's accessible name. */
  remove: string;
}

export interface QuoteListProps {
  /** The composer's reply quotes, in send order. */
  quotes: readonly ComposerQuote[];
  labels: QuoteListLabels;
  onRemove: (id: string) => void;
  /** Start with the rows hidden behind the header. */
  defaultCollapsed?: boolean;
}

/**
 * The reply quotes waiting to go out with the next message, as a card above
 * the composer. Same chrome as the queued-messages card: a header with the
 * count and a collapse toggle, then one row per quote. A row shows one line
 * of the quote, the full text in its `title`, and an X that removes it.
 *
 * Renders nothing for an empty list: the composer mounts it in an
 * `empty:hidden` wrapper.
 */
export function QuoteList({ quotes, labels, onRemove, defaultCollapsed = false }: QuoteListProps) {
  const listId = useId();
  const labelId = useId();
  // Collapse only hides the rows. Nothing is removed, and the count stays.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (quotes.length === 0) return null;

  return (
    <section
      aria-labelledby={labelId}
      className="bg-background border-border flex w-full flex-col rounded-lg border p-1"
    >
      <div className="flex items-center gap-2 py-0.5 pr-1 pl-2">
        <span
          id={labelId}
          className="text-muted-foreground flex min-w-0 flex-1 items-center self-stretch text-xs leading-none"
        >
          {labels.count}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(!collapsed ? 'rotate-180' : 'rotate-0')}
          aria-label={collapsed ? labels.expand : labels.collapse}
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCollapsed((value) => !value)}
        >
          <CaretUpIcon className="size-3.5" />
        </Button>
      </div>
      {!collapsed && (
        <ul id={listId} className="max-h-40 overflow-y-auto">
          {quotes.map((quote) => (
            <li
              key={quote.id}
              data-quote-id={quote.id}
              title={quote.text}
              className="group/quote hover:bg-hover flex min-h-8 items-center gap-x-2 rounded-md border border-transparent px-2 py-0.5"
            >
              <p className="text-foreground min-w-0 flex-1 truncate text-sm">{quote.text}</p>
              <div className="text-muted-foreground flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/quote:opacity-100 group-hover/quote:opacity-100 pointer-coarse:opacity-100">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={labels.remove}
                  onClick={(event) =>
                    quoteListRemove(
                      { id: quote.id, detail: event.detail },
                      { onRemove, focusComposer },
                    )
                  }
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
