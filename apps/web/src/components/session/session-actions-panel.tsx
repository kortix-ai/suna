'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type MessageWithParts, type ToolPart, isToolPart, shouldShowToolPart } from '@/ui';
import { ToolPartRenderer } from './tool-renderers';

/**
 * Flatten a session's messages into the ordered list of tool calls worth
 * showing — the same set the chat transcript renders. This replaces the old
 * `adaptMessagesToToolCalls` adapter: no conversion to a legacy shape, just
 * the native `ToolPart`s in call order.
 */
export function collectToolParts(
  messages: MessageWithParts[] | undefined,
): ToolPart[] {
  if (!messages) return [];
  const parts: ToolPart[] = [];
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (
        isToolPart(part) &&
        part.tool !== 'todoread' &&
        shouldShowToolPart(part as ToolPart)
      ) {
        parts.push(part as ToolPart);
      }
    }
  }
  return parts;
}

/**
 * Side-panel "Actions" view.
 *
 * The focused, one-at-a-time representation of the session's tool calls —
 * a different presentation of the *same* data the chat shows inline. It
 * renders the selected tool through the canonical `ToolPartRenderer` (so
 * there is exactly one tool-rendering implementation), expanded and
 * uncapped to fill the panel, with prev/next navigation and live-follow.
 */
export const SessionActionsPanel = memo(function SessionActionsPanel({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
}) {
  const parts = useMemo(() => collectToolParts(messages), [messages]);
  const count = parts.length;

  const [index, setIndex] = useState(0);
  // 'live' follows the latest tool as new ones stream in; 'manual' pins the
  // user's chosen index until they navigate back to the latest.
  const [mode, setMode] = useState<'live' | 'manual'>('live');

  // Live-follow + clamp when the list grows/shrinks.
  useEffect(() => {
    if (count === 0) return;
    setIndex((i) => (mode === 'live' ? count - 1 : Math.min(i, count - 1)));
  }, [count, mode]);

  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const current = parts[safeIndex];
  const atLatest = safeIndex >= count - 1;

  const goPrev = useCallback(() => {
    setMode('manual');
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setIndex((i) => {
      const next = Math.min(count - 1, i + 1);
      setMode(next >= count - 1 ? 'live' : 'manual');
      return next;
    });
  }, [count]);

  const jumpToLatest = useCallback(() => {
    setMode('live');
    setIndex(Math.max(0, count - 1));
  }, [count]);

  if (count === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground/70">
        No actions yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Body — the focused tool, expanded and uncapped so it fills the panel.
          The `[data-scrollable]` override lifts the inline density caps that
          ToolPartRenderer applies for the chat column. */}
      <div
        key={current?.id}
        className={cn(
          'flex-1 overflow-auto px-4 py-3',
          '[&_[data-scrollable]]:max-h-none [&_[data-scrollable]]:overflow-visible',
        )}
      >
        {current && (
          <ToolPartRenderer part={current} sessionId={sessionId} defaultOpen />
        )}
      </div>

      {/* Navigator — only when there's more than one action. */}
      {count > 1 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-muted/30 px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={goPrev}
            disabled={safeIndex === 0}
            aria-label="Previous action"
          >
            <ChevronLeft className="size-4" />
          </Button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span>
              {safeIndex + 1} <span className="text-muted-foreground/40">/</span>{' '}
              {count}
            </span>
            {atLatest && mode === 'live' ? (
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/50">
                <span className="size-1.5 rounded-full bg-primary/60" />
                Live
              </span>
            ) : (
              <button
                type="button"
                onClick={jumpToLatest}
                className="text-[11px] text-muted-foreground/60 underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                Jump to latest
              </button>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={goNext}
            disabled={atLatest}
            aria-label="Next action"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
});
