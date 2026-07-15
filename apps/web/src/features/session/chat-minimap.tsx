'use client';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import type { Turn } from '@/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  downsampleDashes,
  extractUserText,
  nearestDashIndex,
  type MinimapItem,
} from './chat-minimap-items';

interface ChatMinimapProps {
  turns: Turn[];
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
}

export function ChatMinimap({ turns, scrollRef, contentRef }: ChatMinimapProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Mirrors the hover card's open state so the active row can be scrolled
  // into view when the list mounts.
  const [open, setOpen] = useState(false);

  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  // A user message's text never changes after it's sent — extract once per
  // message id instead of re-stripping every turn on every streaming update.
  const textCacheRef = useRef(new Map<string, string>());

  // One entry per user turn that actually has text.
  const items = useMemo<MinimapItem[]>(() => {
    const cache = textCacheRef.current;
    const result: MinimapItem[] = [];
    for (const turn of turns) {
      const id = turn.userMessage.info.id;
      let text = cache.get(id);
      if (text === undefined) {
        text = extractUserText(turn);
        cache.set(id, text);
      }
      if (text.length > 0) result.push({ id, text });
    }
    return result;
  }, [turns]);

  const dashes = useMemo(() => downsampleDashes(items), [items]);

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.id === activeId),
    [items, activeId],
  );
  const activeDashIndex = useMemo(
    () => nearestDashIndex(dashes, activeIndex),
    [dashes, activeIndex],
  );

  // The observer only cares about which turns exist, not about streaming
  // updates inside them — key it on the id list, not the array identity.
  const idsKey = useMemo(() => items.map((item) => item.id).join('\n'), [items]);

  // Track which turn is currently in view so we can highlight it.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl || idsKey.length === 0) return;

    const ids = new Set(idsKey.split('\n'));
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

    contentEl.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => {
      const id = el.getAttribute('data-turn-id');
      if (id && ids.has(id)) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [scrollRef, contentRef, idsKey]);

  // Keep the active row visible in the expanded jump list.
  useEffect(() => {
    if (!open) return;
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);

  const handleJump = useCallback(
    (id: string) => {
      const contentEl = contentRef.current;
      const scrollEl = scrollRef.current;
      if (!contentEl || !scrollEl) return;
      const target = contentEl.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
      if (!target) return;
      const offset =
        target.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop -
        24;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrollEl.scrollTo({ top: Math.max(0, offset), behavior: reduceMotion ? 'auto' : 'smooth' });
    },
    [contentRef, scrollRef],
  );

  if (items.length < 3) return null;

  return (
    <nav
      aria-label="Jump to message"
      className="pointer-events-none absolute top-1/2 right-3 z-10 -translate-y-1/2 sm:right-4"
    >
      <HoverCard openDelay={100} closeDelay={150} onOpenChange={setOpen}>
        {/* Collapsed rail — a quiet position indicator, like a scrollbar.
            Fades out while the jump list is open so the card reads as the
            rail's expanded form. */}
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label="Jump to message"
            className={cn(
              'hit-area-x-3 hit-area-y-5 pointer-events-auto flex cursor-default flex-col items-end gap-2 rounded-sm px-1.5 py-2',
              'transition-opacity duration-150 ease-out data-[state=open]:opacity-0',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            )}
          >
            {dashes.map(({ item, index }) => (
              <span
                key={item.id}
                aria-hidden
                className={cn(
                  'h-[3px] w-4 origin-right rounded-full',
                  'transition-[background-color,transform] duration-150 ease-out',
                  'motion-reduce:transition-[background-color]',
                  index === activeDashIndex
                    ? 'bg-foreground/60 scale-x-125'
                    : 'bg-muted-foreground/25',
                )}
              />
            ))}
          </button>
        </HoverCardTrigger>

        {/* Expanded jump list — every message, on hover */}
        <HoverCardContent
          side="left"
          align="center"
          sideOffset={0}
          collisionPadding={16}
          className="scrollbar-hide flex max-h-[60vh] w-64 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-lg p-1"
        >
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                ref={isActive ? activeRowRef : undefined}
                aria-current={isActive || undefined}
                onClick={() => handleJump(item.id)}
                className={cn(
                  'cursor-pointer rounded-sm px-2 py-1.5 text-left text-xs leading-snug',
                  'transition-colors duration-100 ease-out',
                  isActive
                    ? 'bg-primary/[0.06] text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-primary/[0.05] hover:text-foreground',
                )}
              >
                <span className="block truncate">{item.text}</span>
              </button>
            );
          })}
        </HoverCardContent>
      </HoverCard>
    </nav>
  );
}
