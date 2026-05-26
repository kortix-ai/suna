'use client';

import { useTranslations } from 'next-intl';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type MessageWithParts, type ToolPart, isToolPart, shouldShowToolPart } from '@/ui';
import { ToolPartRenderer, ToolSurfaceContext } from './tool-renderers';
import {
  useFocusedToolCallId,
  useClearFocusedToolCall,
} from '@/stores/kortix-computer-store';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const parts = useMemo(() => collectToolParts(messages), [messages]);
  const count = parts.length;

  const [index, setIndex] = useState(0);
  // 'live' follows the latest tool as new ones stream in; 'manual' pins the
  // user's chosen index until they navigate back to the latest.
  const [mode, setMode] = useState<'live' | 'manual'>('live');

  // The timestamp is locale/timezone-formatted, so it only matches on the
  // client — render it after mount to avoid an SSR hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Live-follow + clamp when the list grows/shrinks.
  useEffect(() => {
    if (count === 0) return;
    setIndex((i) => (mode === 'live' ? count - 1 : Math.min(i, count - 1)));
  }, [count, mode]);

  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const current = parts[safeIndex];
  const atLatest = safeIndex >= count - 1;

  // Wall-clock time the focused action ran (end if finished, else start).
  const timeLabel = useMemo(() => {
    const t = (current?.state as any)?.time;
    const ms = t?.end ?? t?.start;
    if (typeof ms !== 'number') return '';
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }, [current]);

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

  // Jump to the tool the user clicked in the chat (focus by callID, robust to
  // ordering). Pins manual mode so it doesn't immediately snap back to live.
  const focusedToolCallId = useFocusedToolCallId();
  const clearFocusedToolCall = useClearFocusedToolCall();
  useEffect(() => {
    if (!focusedToolCallId) return;
    const i = parts.findIndex((p) => p.callID === focusedToolCallId);
    if (i >= 0) {
      setMode(i >= count - 1 ? 'live' : 'manual');
      setIndex(i);
    }
    clearFocusedToolCall();
  }, [focusedToolCallId, parts, count, clearFocusedToolCall]);

  // Keyboard ←/→ steps through actions (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          el.closest('.cm-editor') ||
          el.closest('.ProseMirror'))
      ) {
        return;
      }
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

  if (count === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground/70">{tHardcodedUi.raw('componentsSessionSessionActionsPanel.line152JsxTextNoActionsYet')}</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Body — the focused tool rendered in its large, panel-surface view.
          The `[data-scrollable]` override lifts the inline density caps that
          ToolPartRenderer applies for the chat column so content fills here. */}
      <div
        key={current?.id}
        className={cn(
          'min-h-0 flex-1 overflow-auto',
          '[&_[data-scrollable]]:max-h-none [&_[data-scrollable]]:overflow-visible',
        )}
      >
        {current && (
          <ToolSurfaceContext.Provider value="panel">
            <ToolPartRenderer part={current} sessionId={sessionId} defaultOpen />
          </ToolSurfaceContext.Provider>
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
            aria-label={tHardcodedUi.raw('componentsSessionSessionActionsPanel.line185JsxAttrAriaLabelPreviousAction')}
          >
            <ChevronLeft className="size-4" />
          </Button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span>
              {safeIndex + 1} <span className="text-muted-foreground/40">/</span>{' '}
              {count}
            </span>
            {mounted && timeLabel && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="text-muted-foreground/60">{timeLabel}</span>
              </>
            )}
            {atLatest && mode === 'live' ? (
              <span className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground/50">
                <span className="size-1.5 rounded-full bg-primary/60" />
                Live
              </span>
            ) : (
              <button
                type="button"
                onClick={jumpToLatest}
                className="text-xs text-muted-foreground/60 underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >{tHardcodedUi.raw('componentsSessionSessionActionsPanel.line212JsxTextJumpToLatest')}</button>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={goNext}
            disabled={atLatest}
            aria-label={tHardcodedUi.raw('componentsSessionSessionActionsPanel.line223JsxAttrAriaLabelNextAction')}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
});
