'use client';

/**
 * The context-window ring — ONE component for every surface that draws it.
 *
 * The underbar meter (`token-progress.tsx`) and the `/` palette's
 * "Show context" row must be the same glyph with the same live reading and the
 * same status tone, or the palette row reads as a lookalike icon instead of
 * the control it opens. Extracted here so neither surface re-derives the
 * ring's look on its own.
 *
 * `getContextReading` is the pure derivation (percent + tone) over the same
 * exported helpers the hover card uses — pure so it has tests that can fail
 * (this repo's `bun test` has no DOM to assert the SVG itself).
 */

import { ProgressRing } from '@/components/ui/progress-ring';
import { STATUS_TEXT, type StatusTone } from '@/components/ui/status';

import type { ContextReading } from './context-usage';

export { getContextReading, getContextUsage } from './context-usage';
export type { ContextReading, ContextUsage } from './context-usage';

export function ContextRing({ percent, tone, className }: ContextReading & { className?: string }) {
  return (
    <ProgressRing value={percent} className={className} progressClassName={STATUS_TEXT[tone]} />
  );
}
