'use client';

/**
 * The action chronology bar — prev/next, a scrubber, the position, and the
 * wall-clock time of the focused action, with ←/→ stepping the whole run from
 * start to end.
 *
 * Shared by `AdvancedPanel` and Easy's step detail so the two presentations of
 * the same run cannot drift. It owns no list and no selection: the host holds
 * the index and passes it back down, because the host is also what renders the
 * focused action above this bar.
 *
 * The timestamp renders INLINE, not only in the scrubber's hover tooltip: the
 * chronology is the point, and a time you have to hover to find is a time the
 * user does not have. It appears only after mount — it is locale- and
 * timezone-formatted, so rendering it during SSR is a hydration mismatch.
 */

import { Button } from '@/components/ui/button';
import { NativeSlider } from '@/components/ui/slider-native';
import { cn } from '@/lib/utils';
import type { ToolPart } from '@/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type FollowMode,
  actionTimeLabel,
  isEditableTarget,
  nextIndex,
  prevIndex,
} from './action-navigator-logic';

export function ActionNavigator({
  parts,
  index,
  onIndexChange,
  isLive,
  className,
}: {
  parts: ToolPart[];
  index: number;
  /** Reports both the new index and what it implies for live-follow, so the
   *  host never has to re-derive the mode rule and get it subtly different. */
  onIndexChange: (index: number, mode: FollowMode) => void;
  isLive: boolean;
  className?: string;
}) {
  const count = parts.length;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const timeLabel = useMemo(() => actionTimeLabel(parts[index], new Date()), [parts, index]);

  const goPrev = useCallback(() => {
    const { index: i, mode } = prevIndex(index);
    onIndexChange(i, mode);
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    const { index: i, mode } = nextIndex(index, count);
    onIndexChange(i, mode);
  }, [index, count, onIndexChange]);

  const handleScrub = useCallback(
    (values: number[]) => {
      const next = Math.min(count - 1, Math.max(0, values[0] ?? 0));
      onIndexChange(next, next >= count - 1 ? 'live' : 'manual');
    },
    [count, onIndexChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(document.activeElement as HTMLElement | null)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

  if (count <= 1) return null;

  const atLatest = index >= count - 1;

  return (
    <div
      className={cn(
        'border-border flex shrink-0 items-center gap-2 border-t px-2 py-1.5 pr-3.5',
        className,
      )}
    >
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={goPrev}
          className="hit-area-2 hit-area-r-0"
          disabled={index === 0}
          aria-label="Previous action"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={goNext}
          className="hit-area-2 hit-area-l-0"
          disabled={atLatest}
          aria-label="Next action"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <NativeSlider
        value={[index]}
        min={0}
        max={count - 1}
        step={1}
        onValueChange={handleScrub}
        tooltip={timeLabel ? <span className="tabular-nums">{timeLabel}</span> : undefined}
        className={cn(
          'min-w-0 flex-1',
          '[&_[data-slot=slider-thumb]]:transition-[background-color,border-color,box-shadow]',
        )}
      />

      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 pl-1 text-xs tabular-nums">
        {mounted && timeLabel && <span className="text-muted-foreground/60">{timeLabel}</span>}
        <span>
          {index + 1}
          <span className="text-muted-foreground/40">/</span>
          {count}
        </span>
        {isLive && atLatest && (
          <span className="bg-primary/60 size-1.5 rounded-full" aria-label="Live" />
        )}
      </span>
    </div>
  );
}
