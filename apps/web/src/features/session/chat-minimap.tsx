'use client';

import { CubeIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { useIsSidePanelOpen } from '@/stores/kortix-computer-store';
import type { Turn } from '@/ui';

import { MENU_PANEL } from '@/components/ui/menu-recipe';
import {
  DASH_ROW_HEIGHT,
  DASH_THICKNESS,
  RAIL_WIDTH,
  dashCenterY,
  dashOpacity,
  dashWidth,
  downsampleDashes,
  extractMinimapItem,
  nearestDashRow,
  type MinimapItem,
} from './chat-minimap-items';

interface ChatMinimapProps {
  turns: Turn[];
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  /** Key of the turn ids currently MOUNTED, when the transcript is windowed.
   *  A windowed transcript mounts and unmounts turns as the reader scrolls,
   *  and an observer armed once would never see the ones that arrive later.
   *  Undefined when every turn is mounted, which leaves behavior unchanged. */
  renderedIdsKey?: string;
  /**
   * Scrolls to a turn that may not be mounted. Returns true when it handled
   * the jump.
   *
   * Without this the rail is decorative for most of its dashes: the minimap
   * only renders at 3+ turns, and in a windowed transcript most of those are
   * unmounted, so the DOM lookup finds nothing and the click is silently
   * dropped.
   */
  onJumpToTurn?: (turnId: string) => boolean;
}

function MinimapCard({ item }: { item: MinimapItem }) {
  const hasBody = item.segments.length > 0;

  return (
    <div className={cn(MENU_PANEL, 'w-64 rounded-md border px-3 py-2.5')}>
      {hasBody && (
        <p className="text-muted-foreground line-clamp-3 text-xs leading-5">
          {item.segments.map((segment, i) =>
            segment.mention ? (
              <span key={i} className="text-foreground font-medium">
                {segment.mention === 'agent' ? (
                  <CubeIcon className="mr-1 inline size-3 align-[-0.15em]" />
                ) : null}
                {segment.text}
              </span>
            ) : (
              <span key={i}>{segment.text}</span>
            ),
          )}
        </p>
      )}
    </div>
  );
}

export function ChatMinimap({
  turns,
  scrollRef,
  contentRef,
  renderedIdsKey,
  onJumpToTurn,
}: ChatMinimapProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  // The rail lives in the chat's left gutter, and that gutter only exists
  // while the chat owns the whole column. The moment a detail opens on the
  // right — terminal, browser, a file, a deck, a PDF — the reading column is
  // squeezed and the rail is competing for width with the thing the reader
  // just asked to look at. It also stops being useful: attention is on the
  // detail, not on jumping around the transcript.
  //
  // `isSidePanelOpen` is the flag for exactly that panel (it is deliberately
  // separate from `isActionPanelOpen`, which is the floating card overlay in
  // the chat's TOP-RIGHT — that one leaves the left gutter alone, so it must
  // not hide the rail).
  const sidePanelOpen = useIsSidePanelOpen();

  // Which row the pointer (or keyboard focus) is on, and which row the card is
  // showing. They differ only while the card fades out — the card keeps its
  // last message so it dissolves in place instead of blanking first.
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [shownRow, setShownRow] = useState(0);

  const focusRow = useCallback((row: number | null) => {
    setHoverRow(row);
    if (row !== null) setShownRow(row);
  }, []);

  // One entry per user turn that has something to preview. A message's content
  // never changes after it is sent, so extract once per message id rather than
  // re-parsing every turn on every streaming update.
  const [itemCache] = useState(() => new Map<string, MinimapItem | null>());
  const items = useMemo<MinimapItem[]>(() => {
    const result: MinimapItem[] = [];
    for (const turn of turns) {
      const id = turn.userMessage.info.id;
      let item = itemCache.get(id);
      if (item === undefined) {
        item = extractMinimapItem(turn);
        itemCache.set(id, item);
      }
      if (item) result.push(item);
    }
    return result;
  }, [turns, itemCache]);

  const dashes = useMemo(() => downsampleDashes(items), [items]);

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.id === activeId),
    [items, activeId],
  );
  const activeRow = useMemo(() => nearestDashRow(dashes, activeIndex), [dashes, activeIndex]);

  // Idle, the rail reports scroll position. On hover it follows the pointer.
  const focusedRow = hoverRow ?? activeRow;

  // The observer only cares about which turns exist, not about streaming
  // updates inside them — key it on the id list, not the array identity.
  const idsKey = useMemo(() => items.map((item) => item.id).join('\n'), [items]);

  // Track which turn is currently in view so we can highlight it.
  //
  // NOT `useMessageScrollerVisibility().currentAnchorId`, which is what this
  // wants and cannot use. That hook projects its answer by walking
  // `MessageScrollerContent`'s DIRECT children and reading `data-message-id`
  // off each one (`ee()`/`Fe()` in @shadcn/react/message-scroller, both
  // `Array.from(content.children)`). Our anchors are virtualized rows, so they
  // live one level down, inside TranscriptList's positioned container — the
  // element that has to carry the projected total height. The scroller's own
  // IntersectionObserver does see them (it observes the registered elements at
  // any depth), but the direct-children filter drops every id before the hook
  // returns, so `currentAnchorId` is permanently null here.
  //
  // Rather than ship a highlight that never lights up, this keeps its own
  // observer. Jumping does go through the scroller — see `onJumpToTurn`.
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
    // `renderedIdsKey` re-arms the observer when a windowed transcript mounts
    // or unmounts turns. It changes only when the mounted SET changes, never
    // on a streamed token — so this keeps the property `idsKey` was chosen
    // for above: no re-arming per token.
  }, [scrollRef, contentRef, idsKey, renderedIdsKey]);

  const handleJump = useCallback(
    (id: string) => {
      const contentEl = contentRef.current;
      const scrollEl = scrollRef.current;
      if (!contentEl || !scrollEl) return;
      // Every dash in the rail is built from ALL turns, but a windowed
      // transcript only mounts the ones near the viewport — so the DOM lookup
      // below returns null for most dashes and the click does nothing at all.
      // Ask the virtualizer to bring the turn into view instead.
      if (onJumpToTurn?.(id)) return;
      const target =
        contentEl.querySelector<HTMLElement>(`[data-turn-start="${CSS.escape(id)}"]`) ??
        contentEl.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
      if (!target) return;
      const offset =
        target.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop -
        24;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrollEl.scrollTo({ top: Math.max(0, offset), behavior: reduceMotion ? 'auto' : 'smooth' });
    },
    [contentRef, scrollRef, onJumpToTurn],
  );

  if (items.length < 3 || sidePanelOpen) return null;

  const shown = dashes[shownRow]?.item ?? dashes[0].item;
  const open = hoverRow !== null;

  return (
    <nav
      aria-label="Jump to message"
      // Desktop only. On phone and tablet the rail is a 3px pointer target
      // sitting on top of the chat — there is no hover, and the gutter it needs
      // does not exist.
      className="pointer-events-none absolute top-1/2 left-2 z-10 hidden -translate-y-1/2 lg:block"
    >
      {/* Preview opens toward the chat (right of the rail). */}
      <div
        aria-hidden
        className={cn(
          'absolute top-0 left-full pl-1.5',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
        )}
        style={{ transform: `translateY(calc(${dashCenterY(shownRow)}px - 50%))` }}
      >
        <div
          className={cn(
            'origin-left transition-[opacity,transform,filter] duration-150 ease-out',
            'motion-reduce:transition-[opacity]',
            open
              ? 'scale-100 opacity-100 blur-none'
              : 'pointer-events-none scale-[0.97] opacity-0 blur-[2px]',
          )}
        >
          <MinimapCard item={shown} />
        </div>
      </div>

      {/* Rows TILE — no gap between them — so every pixel of the rail belongs
          to a message and the pointer never falls into a dead band. The gap
          you see is the row's padding around a 3px dash. */}
      <div
        className="pointer-events-auto flex flex-col items-stretch"
        style={{ width: RAIL_WIDTH }}
        onPointerLeave={() => focusRow(null)}
      >
        {dashes.map(({ item }, row) => {
          const distance = focusedRow < 0 ? Infinity : Math.abs(row - focusedRow);
          const isFocused = distance === 0;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Jump to message: ${item.text}`}
              aria-current={dashes[row].index === activeIndex || undefined}
              style={{ height: DASH_ROW_HEIGHT }}
              // No `title`: a native tooltip would pop up on top of the card
              // that already says the same thing, only better.
              // Focus opens the card and magnifies the dash, but a keyboard
              // user still needs a ring they can locate — it goes on the ROW,
              // because a ring around a 3px dash is unreadable.
              className={cn(
                'hit-area-x-5 last:hit-area-b-3 first:hit-area-t-3 flex cursor-pointer items-center justify-start rounded-sm px-0.5',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              )}
              onPointerEnter={() => focusRow(row)}
              onFocus={() => focusRow(row)}
              onBlur={() => focusRow(null)}
              onClick={() => handleJump(item.id)}
            >
              <span
                aria-hidden
                style={{
                  width: dashWidth(distance),
                  height: DASH_THICKNESS,
                  opacity: dashOpacity(distance),
                }}
                className={cn(
                  'rounded-full',
                  'transition-[width,opacity,background-color] duration-200 ease-out',
                  'motion-reduce:transition-[opacity,background-color]',
                  isFocused ? 'bg-foreground' : 'bg-muted-foreground',
                )}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
