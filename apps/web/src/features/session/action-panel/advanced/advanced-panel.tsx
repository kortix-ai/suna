'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { useClearFocusedToolCall, useFocusedToolCallId } from '@/stores/kortix-computer-store';
import type { MessageWithParts } from '@/ui';
import { memo, useEffect, useMemo, useState } from 'react';
import { ActionNavigator } from '../shared/action-navigator';
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

      <ActionNavigator
        parts={parts}
        index={safeIndex}
        isLive={isLive}
        onIndexChange={(i, m) => {
          setMode(m);
          setIndex(i);
        }}
      />
    </div>
  );
});
