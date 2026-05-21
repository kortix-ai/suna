'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Turn, type MessageWithParts, isTextPart, type TextPart } from '@/ui';
import { cn } from '@/lib/utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';

interface ChatMinimapProps {
  turns: Turn[];
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  messages: MessageWithParts[];
}

function extractUserText(turn: Turn): string {
  const textParts = turn.userMessage.parts.filter(isTextPart) as TextPart[];
  const raw = textParts.map((p) => p.text).join(' ');
  const stripped = stripKortixSystemTags(raw);
  return stripped.replace(/<[^>]+>/g, '').trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\u2026';
}

export function ChatMinimap({ turns, scrollRef, contentRef }: ChatMinimapProps) {
  const [visibleTurnId, setVisibleTurnId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl || turns.length === 0) return;

    observerRef.current?.disconnect();
    const visibleMap = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const turnId = el.getAttribute('data-turn-id');
          if (!turnId) continue;
          visibleMap.set(turnId, entry.intersectionRatio);
        }
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const [id, ratio] of visibleMap) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }
        if (bestId) setVisibleTurnId(bestId);
      },
      {
        root: scrollEl,
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      },
    );

    const turnEls = contentEl.querySelectorAll<HTMLElement>('[data-turn-id]');
    turnEls.forEach((el) => observer.observe(el));
    observerRef.current = observer;

    return () => observer.disconnect();
  }, [scrollRef, contentRef, turns]);

  const handleBarClick = useCallback(
    (turnId: string) => {
      const contentEl = contentRef.current;
      const scrollEl = scrollRef.current;
      if (!contentEl || !scrollEl) return;

      const target = contentEl.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
      if (!target) return;

      const scrollRect = scrollEl.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offset = targetRect.top - scrollRect.top + scrollEl.scrollTop - 24;

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
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
  }, []);

  if (turns.length < 3) return null;

  return (
    <div
      className={cn(
        'absolute right-3 sm:right-4 z-10 flex items-start justify-end pointer-events-none',
        'top-1/2 -translate-y-1/2',
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          'pointer-events-auto flex flex-col transition-all duration-200 ease-out',
          hovered
            ? 'bg-popover/95 backdrop-blur-md rounded-2xl border border-border/30 px-1.5 py-2 min-w-[220px] max-w-[280px] max-h-[60vh] overflow-y-auto scrollbar-hide gap-0'
            : 'py-1 gap-[5px]',
        )}
      >
        {turns.map((turn) => {
          const turnId = turn.userMessage.info.id;
          const isActive = turnId === visibleTurnId;
          const text = extractUserText(turn);
          if (!text) return null;

          if (hovered) {
            return (
              <button
                key={turnId}
                type="button"
                onClick={() => handleBarClick(turnId)}
                className={cn(
                  'flex items-center gap-2.5 py-1.5 px-2.5 rounded-lg text-left cursor-pointer transition-colors duration-100',
                  isActive
                    ? 'bg-muted/80'
                    : 'hover:bg-muted/40',
                )}
              >
                <div
                  className={cn(
                    'w-[5px] h-[5px] rounded-full flex-shrink-0 transition-colors',
                    isActive ? 'bg-foreground' : 'bg-muted-foreground/30',
                  )}
                />
                <span
                  className={cn(
                    'text-xs leading-snug truncate',
                    isActive
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground/70',
                  )}
                >
                  {truncate(text, 40)}
                </span>
              </button>
            );
          }

          return (
            <button
              key={turnId}
              type="button"
              onClick={() => handleBarClick(turnId)}
              className="cursor-pointer group"
              title={truncate(text, 60)}
            >
              <div
                className={cn(
                  'w-[18px] h-[3px] rounded-full transition-all duration-150',
                  isActive
                    ? 'bg-foreground/50'
                    : 'bg-muted-foreground/20 group-hover:bg-muted-foreground/35',
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
