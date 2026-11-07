/**
 * Select to copy: drag over any text, and the moment the mouse goes up the
 * selection is on the clipboard.
 *
 * The TUI takes the mouse (clicks on tabs, the sidebar, the symbol), so the
 * terminal's own selection never sees the drag. OpenTUI selects instead and
 * emits `selection` when the drag ends (`finishSelection`); this hook writes
 * that text to the system clipboard with OSC 52, which works over SSH and in
 * tmux, and tells the host so it can say "Copied".
 */

import type { Selection } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { useEffect, useRef } from 'react';

export function useCopyOnSelect(onCopied: (text: string) => void): void {
  const renderer = useRenderer();
  const onCopiedRef = useRef(onCopied);
  onCopiedRef.current = onCopied;

  useEffect(() => {
    const copy = (selection: Selection | null) => {
      const text = selection?.getSelectedText() ?? '';
      // A click is a selection of nothing: only a drag that covered text copies.
      if (!text.trim()) return;
      if (renderer.copyToClipboardOSC52(text)) onCopiedRef.current(text);
    };
    renderer.on('selection', copy);
    return () => {
      renderer.off('selection', copy);
    };
  }, [renderer]);
}
