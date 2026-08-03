'use client';

import { useContext } from 'react';

import { ToolSurfaceContext } from '@/features/session/tool/shared/surface';
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
  const surface = useContext(ToolSurfaceContext);

  return (
    <div
      className={cn(
        'rounded-md border p-1',
        TONE_CLASS[tone],
        // 28px = an inline row's icon column (`size-4`) plus its `gap-3`, so
        // the card starts on the label's column. The panel surface has no such
        // gutter and supplies its own padding, where the indent would only
        // push content off-centre.
        surface === 'inline' && 'mt-1.5 ml-7',
        className,
      )}
    >
      {/* Scrolling lives inside the padding so the scrollbar never rides the
			    card's border, and a clipped row stays visibly clipped — the cue that
			    there is more below. */}
      <div data-scrollable className={cn('max-h-[19rem] overflow-auto', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
