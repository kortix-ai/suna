'use client';

import type { SessionBoardState } from '@kortix/sdk';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { StatusDot, type StatusTone } from '../../primitives/status';

/**
 * One hue per state (color.md, D5): working is live (green), needs input asks
 * for attention (orange), completed succeeded (green), failed broke (red);
 * idle and stopped carry no hue. The word beside the dot says the state, so
 * the color is never the only carrier.
 */
export const BOARD_STATE_TONE: Record<SessionBoardState, StatusTone> = {
  working: 'success',
  needs_input: 'warning',
  idle: 'neutral',
  completed: 'success',
  failed: 'destructive',
  stopped: 'neutral',
};

/** The state dot and its word. A working dot pulses: it is the one state that changes while you watch. */
export function BoardStateMark({
  state,
  showLabel = true,
  className,
}: {
  state: SessionBoardState;
  showLabel?: boolean;
  className?: string;
}) {
  const t = useTranslations('multiAgent.board.state');
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)} data-board-state={state}>
      <StatusDot tone={BOARD_STATE_TONE[state]} pulse={state === 'working'} className="motion-reduce:animate-none" />
      <span className={cn(showLabel ? 'text-muted-foreground text-xs' : 'sr-only')}>{t(state)}</span>
    </span>
  );
}
