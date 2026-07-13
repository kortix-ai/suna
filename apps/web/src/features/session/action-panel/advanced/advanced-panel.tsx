'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { NativeSlider } from '@/components/ui/slider-native';
import { cn } from '@/lib/utils';
import { useClearFocusedToolCall, useFocusedToolCallId } from '@/stores/kortix-computer-store';
import { type MessageWithParts, type ToolPart, isToolPart, shouldShowToolPart } from '@/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { collectToolParts } from '../shared/collect-tool-parts';
import {
  ToolPartRenderer,
  ToolSurfaceContext,
} from '../../tool/tool-renderers';

/**
 * Side-panel "Actions" view.
 *
 * The focused, one-at-a-time representation of the session's tool calls —
 * a different presentation of the *same* data the chat shows inline. It
 * renders the selected tool through the canonical `ToolPartRenderer` (so
 * there is exactly one tool-rendering implementation), expanded and
 * uncapped to fill the panel, with prev/next navigation and live-follow.
 */
export const AdvancedPanel = memo(function AdvancedPanel({
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

  // Live-follow + clamp when the list grows/shrinks.
  useEffect(() => {
    if (count === 0) return;
    setIndex((i) => (mode === 'live' ? count - 1 : Math.min(i, count - 1)));
  }, [count, mode]);

  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const current = parts[safeIndex];
  const atLatest = safeIndex >= count - 1;
  const isLive = atLatest && mode === 'live';

  // Wall-clock time the focused action ran (end if finished, else start),
  // shown in the scrubber's hover hint. Same-day actions get just the time;
  // older ones get the date too.
  const timeLabel = useMemo(() => {
    const t = (current?.state as any)?.time;
    const ms = t?.end ?? t?.start;
    if (typeof ms !== 'number') return '';
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
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

  // Scrubbing to the end re-arms live-follow; anywhere else pins manual.
  const handleScrub = useCallback(
    (values: number[]) => {
      const next = Math.min(count - 1, Math.max(0, values[0] ?? 0));
      setMode(next >= count - 1 ? 'live' : 'manual');
      setIndex(next);
    },
    [count],
  );

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
          el.closest('.ProseMirror') ||
          // The scrubber thumb handles ←/→ itself — don't double-step.
          el.closest('[data-slot="slider"]'))
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
      <div className="text-muted-foreground/70 flex h-full items-center justify-center p-8 text-center text-sm">
        {tHardcodedUi.raw('componentsSessionSessionActionsPanel.line152JsxTextNoActionsYet')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
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

      {count > 1 && (
        <div className="border-border flex shrink-0 items-center gap-2 border-t px-2 py-1.5 pr-3.5">
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={goPrev}
              className="hit-area-2 hit-area-r-0"
              disabled={safeIndex === 0}
              aria-label={tHardcodedUi.raw(
                'componentsSessionSessionActionsPanel.line185JsxAttrAriaLabelPreviousAction',
              )}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={goNext}
              className="hit-area-2 hit-area-l-0"
              disabled={atLatest}
              aria-label={tHardcodedUi.raw(
                'componentsSessionSessionActionsPanel.line223JsxAttrAriaLabelNextAction',
              )}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <NativeSlider
            value={[safeIndex]}
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

          <span className="text-muted-foreground shrink-0 pl-1 text-xs tabular-nums">
            {safeIndex + 1}
            <span className="text-muted-foreground/40">/</span>
            {count}
          </span>
        </div>
      )}
    </div>
  );
});
