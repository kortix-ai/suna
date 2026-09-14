import React from 'react';

interface MarkerDigitsInput {
  start?: number;
  itemCount: number;
  reversed?: boolean;
}

/**
 * Characters in the widest ordinal the list paints, minus sign included.
 * Mirrors the HTML list-item counter: `start` defaults to 1, or to the item
 * count when the list is `reversed`.
 */
export function orderedListMarkerDigits({
  start,
  itemCount,
  reversed = false,
}: MarkerDigitsInput): number {
  const count = Math.max(itemCount, 1);
  const first =
    start !== undefined && Number.isFinite(start) ? Math.trunc(start) : reversed ? count : 1;
  const last = reversed ? first - count + 1 : first + count - 1;
  return Math.max(String(first).length, String(last).length);
}

/**
 * The `ol` inline-start padding for markers of `digits` characters.
 *
 * `list-outside` markers hang in this padding, end-aligned to the text. A
 * fixed `pl-6` (22.08px) holds `9. ` (16.3px at 15px Roobert, weight 500,
 * tabular) but not `10. ` (25.7px), so the leading digit painted past the list
 * edge and any `overflow-hidden` ancestor cut it. Each extra digit adds `1ch`:
 * Roobert's `0` advance (0.632em) covers its tabular digit (0.630em), so the
 * slack left of the widest marker stays ~5.8px at every digit count and scales
 * with the font size. No spacing step can express a glyph-relative width.
 */
export function orderedListGutter(digits: number): string {
  return `calc(var(--spacing) * 6 + ${Math.max(digits - 1, 0)}ch)`;
}

interface MarkdownOrderedListProps {
  children?: React.ReactNode;
  start?: number | string;
  reversed?: boolean;
}

function parseStart(start: number | string | undefined): number | undefined {
  if (start === undefined) return undefined;
  const value = typeof start === 'string' ? Number.parseInt(start, 10) : start;
  return Number.isFinite(value) ? value : undefined;
}

// Shared by UnifiedMarkdown and DocMarkdown so the two renderers cannot drift.
export function MarkdownOrderedList({ children, start, reversed }: MarkdownOrderedListProps) {
  const startOrdinal = parseStart(start);
  const itemCount = React.Children.toArray(children).filter(React.isValidElement).length;
  const digits = orderedListMarkerDigits({ start: startOrdinal, itemCount, reversed });

  return (
    <ol
      start={startOrdinal}
      reversed={reversed}
      className="marker:text-muted-foreground/80 my-4 list-outside list-decimal space-y-1 marker:font-medium marker:tabular-nums first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0"
      style={{ paddingInlineStart: orderedListGutter(digits) }}
    >
      {children}
    </ol>
  );
}
