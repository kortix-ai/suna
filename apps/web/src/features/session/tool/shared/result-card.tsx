'use client';

import { useToolCardFrame, useToolIndent } from '@/features/session/tool/shared/surface';
import { cn } from '@/lib/utils';

/**
 * The card a tool's result list lives in — web sources, matched files, grep
 * hits, patched files.
 *
 * A run of rows should read as one object the tool returned, not as loose rows
 * leaking into the step list around it. Every one of these tools previously
 * rendered a bare `max-h-72 overflow-auto` div, so the rows had no edge and ran
 * straight into the chain rail beside them.
 *
 * Elevation is the hairline alone: the tool-view grammar forbids shadows
 * (asserted in conformance.test.ts). `--popover` already lifts off
 * `--background` in dark mode; in light both are pure white, so the border does
 * the work on its own.
 */
const TONE_CLASS = {
  default: 'border-border bg-popover',
  // A tint, not a fill. `bg-destructive/50` puts half-opacity red behind body
  // text and a stack trace, which is both unreadable and louder than the
  // failure warrants; the border carries the signal and the wash only supports
  // it.
  destructive: 'border-destructive/40 bg-destructive/10',
} as const;

export function ToolResultCard({
  children,
  className,
  bodyClassName,
  tone = 'default',
}: {
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** `destructive` tints the card for failures. Opt in per call site — it is
   *  NOT the default, because this same card holds web sources, globbed files,
   *  grep hits and patched files, none of which are errors. */
  tone?: keyof typeof TONE_CLASS;
}) {
  const indent = useToolIndent();
  const frame = useToolCardFrame();
  // A tint is not a frame. On the panel the row card already draws the neutral
  // edge, so this card drops its own (see `useToolCardFrame`) — but a failure's
  // `border-destructive/40 bg-destructive/10` is the signal itself, and the row
  // card has no way to carry it. Destructive keeps its edge on both surfaces.
  const framed = tone === 'destructive' || frame !== '';

  return (
    <div
      className={cn(
        // `p-1` is the ONE inset that stays on the frame rather than moving to
        // the body, and it is kept deliberately: the body is a scroll
        // container, so padding put there scrolls away with the content and a
        // scrolled row would sit flush against the border. 4px on the frame is
        // a gutter that cannot scroll — it keeps the scrollbar off the border
        // and keeps a clipped row visibly clipped. The rows' own inset
        // (`px-2 py-1.5`) is the callers' `bodyClassName`, inside the scroller
        // where it belongs.
        // `p-1` survives the de-nest: it is the scrollbar gutter, not a second
        // inset — 4px inside the row body's 12px, which is where the rows'
        // own `bodyClassName` inset already sits.
        'p-1',
        framed && ['rounded-md border', TONE_CLASS[tone]],
        // The same `mt-1.5` seam + shared indent every other card under a tool
        // row uses (`ToolCodeCard`, `ToolOutputCard`, `bash`'s command card),
        // and gated the same way. The indent was `ml-7` — 28px, derived from a
        // `gap-3` this row class does not have — so this card and
        // `ToolCodeCard` disagreed by 6px on the very same expanded row. Both
        // are inline-only: on the panel the card IS the disclosure body, whose
        // `px-3 py-3` is the whole inset.
        indent && 'mt-1.5',
        indent,
        className,
      )}
    >
      <div data-scrollable className={cn('max-h-96 overflow-auto', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
