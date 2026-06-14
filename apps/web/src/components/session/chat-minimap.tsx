'use client';

import { cn } from '@/lib/utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { stripHtmlTags } from '@/lib/utils/strip-html-tags';
import { isTextPart, type MessageWithParts, type TextPart, type Turn } from '@/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ChatMinimapProps {
  turns: Turn[];
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  messages: MessageWithParts[];
}

interface MinimapItem {
  id: string;
  text: string;
}

// How many dashes the collapsed rail shows at most. Longer sessions are
// down-sampled to this many so the rail stays quiet — every message is still
// listed in the expanded view.
const MAX_DASHES = 12;

function extractUserText(turn: Turn): string {
  const textParts = turn.userMessage.parts.filter(isTextPart) as TextPart[];
  const raw = textParts.map((p) => p.text).join(' ');
  return stripHtmlTags(stripKortixSystemTags(raw)).trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '…';
}

export function ChatMinimap({ turns, scrollRef, contentRef }: ChatMinimapProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One entry per user turn that actually has text.
  const items = useMemo<MinimapItem[]>(
    () =>
      turns
        .map((turn) => ({ id: turn.userMessage.info.id, text: extractUserText(turn) }))
        .filter((item) => item.text.length > 0),
    [turns],
  );

  // Down-sampled set of dashes for the collapsed rail (evenly spaced).
  const dashes = useMemo<{ item: MinimapItem; index: number }[]>(() => {
    if (items.length <= MAX_DASHES) {
      return items.map((item, index) => ({ item, index }));
    }
    return Array.from({ length: MAX_DASHES }, (_, d) => {
      const index = Math.round((d * (items.length - 1)) / (MAX_DASHES - 1));
      return { item: items[index], index };
    });
  }, [items]);

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.id === activeId),
    [items, activeId],
  );

  // Which dash to light up — the one nearest the active turn.
  const activeDashIndex = useMemo(() => {
    if (activeIndex < 0) return -1;
    let best = -1;
    let bestDist = Infinity;
    for (const dash of dashes) {
      const dist = Math.abs(dash.index - activeIndex);
      if (dist < bestDist) {
        bestDist = dist;
        best = dash.index;
      }
    }
    return best;
  }, [dashes, activeIndex]);

  // Track which turn is currently in view so we can highlight it.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl || items.length === 0) return;

    const visibleMap = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).getAttribute('data-turn-id');
          if (!id) continue;
          visibleMap.set(id, entry.intersectionRatio);
        }
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const [id, ratio] of visibleMap) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }
        if (bestId) setActiveId(bestId);
      },
      { root: scrollEl, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    contentEl.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [scrollRef, contentRef, items]);

  // Keep the active row visible in the expanded jump list.
  useEffect(() => {
    if (!hovered) return;
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hovered, activeId]);

  const handleJump = useCallback(
    (id: string) => {
      const contentEl = contentRef.current;
      const scrollEl = scrollRef.current;
      if (!contentEl || !scrollEl) return;
      const target = contentEl.querySelector<HTMLElement>(`[data-turn-id="${id}"]`);
      if (!target) return;
      const offset =
        target.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop -
        24;
      scrollEl.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    },
    [contentRef, scrollRef],
  );

  const handleMouseEnter = useCallback(() => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    leaveTimerRef.current = setTimeout(() => {
      setHovered(false);
      leaveTimerRef.current = null;
    }, 180);
  }, []);

  useEffect(
    () => () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  if (items.length < 3) return null;

  return (
    <div
      className="pointer-events-none absolute top-1/2 right-3 z-10 -translate-y-1/2 sm:right-4"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Collapsed rail — a few quiet dashes */}
      <div
        className={cn(
          'flex flex-col items-end py-1',
          'transition-opacity duration-200 ease-out',
          hovered ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      >
        {dashes.map(({ item, index }) => {
          const isActive = index === activeDashIndex;
          return (
            <button
              key={`${item.id}-${index}`}
              type="button"
              onClick={() => handleJump(item.id)}
              title={truncate(item.text, 60)}
              className="group pointer-events-auto flex cursor-pointer items-center justify-end px-1.5 py-[3px]"
            >
              <span
                className={cn(
                  'h-[3px] w-4 rounded-full transition-all duration-150',
                  isActive
                    ? 'bg-foreground/60'
                    : 'bg-muted-foreground/20 group-hover:bg-muted-foreground/40',
                )}
              />
            </button>
          );
        })}
      </div>

      {/* Expanded jump list — every message, on hover */}
      <div
        className={cn(
          'absolute top-1/2 right-0 origin-right -translate-y-1/2',
          'transition-all duration-200 ease-out',
          hovered
            ? 'pointer-events-auto scale-100 opacity-100'
            : 'pointer-events-none scale-95 opacity-0',
        )}
      >
        <div className="scrollbar-hide border-border/40 bg-popover/95 flex max-h-[60vh] w-[268px] flex-col gap-0.5 overflow-y-auto rounded-2xl border p-1.5 shadow-xl backdrop-blur-md">
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                ref={isActive ? activeRowRef : undefined}
                onClick={() => handleJump(item.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-100',
                  isActive ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'h-[3px] w-3 flex-shrink-0 rounded-full',
                    isActive ? 'bg-foreground/70' : 'bg-muted-foreground/30',
                  )}
                />
                <span
                  className={cn(
                    'flex-1 truncate text-xs leading-snug',
                    isActive ? 'text-foreground font-medium' : 'text-muted-foreground',
                  )}
                >
                  {truncate(item.text, 44)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
