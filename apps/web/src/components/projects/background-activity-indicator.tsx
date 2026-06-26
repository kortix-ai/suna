'use client';

import { useEffect, useRef, useState } from 'react';

import { useSyncStore } from '@/stores/opencode-sync-store';

/**
 * Makes a working agent VISIBLE while its tab is in the background.
 *
 * A hidden browser tab is never painted by the engine — that's a hard platform
 * constraint, so the chat itself can't render live updates while you're on
 * another tab/app. What a tab CAN still update in the background is its title
 * text and favicon (the Gmail/Slack unread pattern). Without that, a session
 * that keeps streaming server-side looks frozen/dead in the tab strip, which
 * reads as "it stopped working in the background" even though the connection is
 * alive and the agent is making progress (the SSE stream keeps applying events
 * into the store — see use-opencode-events).
 *
 * This headless component watches the sync store for any busy/retry session and,
 * while the tab is hidden, prefixes the document title with a "(working…)"
 * badge and overlays a dot on the favicon. Both revert the instant the tab is
 * shown again or all sessions go idle. Best-effort and fully self-contained — it
 * never touches the connection, the cache, or the store.
 */
export function BackgroundActivityIndicator() {
  const busyCount = useSyncStore((s) => countBusy(s.sessionStatus));
  const [away, setAway] = useState(false);

  // "Away" = the user isn't looking at this tab. That's true both when the tab
  // is in the background (document.hidden, e.g. another tab) AND when the whole
  // browser window lost focus to another app (Slack/Cursor) while this tab is
  // still the active one — where document.hidden stays false but the user can't
  // see live updates. Mirrors web-notifications' isTabHidden() definition.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const compute = () => setAway(document.hidden || !document.hasFocus());
    compute();
    document.addEventListener('visibilitychange', compute);
    window.addEventListener('blur', compute);
    window.addEventListener('focus', compute);
    return () => {
      document.removeEventListener('visibilitychange', compute);
      window.removeEventListener('blur', compute);
      window.removeEventListener('focus', compute);
    };
  }, []);

  // Saved originals so we always restore exactly what was there before.
  const baseTitleRef = useRef<string | null>(null);
  const faviconRef = useRef<{ el: HTMLLinkElement; original: string } | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const active = away && busyCount > 0;

    if (active) {
      if (baseTitleRef.current === null) baseTitleRef.current = document.title;
      const label = busyCount > 1 ? `(${busyCount} working…)` : '(working…)';
      document.title = `${label} ${baseTitleRef.current}`;
      applyFaviconDot(faviconRef);
    } else {
      restoreTitle(baseTitleRef);
      restoreFavicon(faviconRef);
    }
  }, [away, busyCount]);

  // Always restore on unmount (navigating away from the project area).
  useEffect(
    () => () => {
      restoreTitle(baseTitleRef);
      restoreFavicon(faviconRef);
    },
    [],
  );

  return null;
}

function countBusy(status: Record<string, { type?: string } | undefined>): number {
  let n = 0;
  for (const s of Object.values(status)) {
    if (s?.type === 'busy' || s?.type === 'retry') n += 1;
  }
  return n;
}

function restoreTitle(ref: React.MutableRefObject<string | null>): void {
  if (ref.current !== null) {
    document.title = ref.current;
    ref.current = null;
  }
}

function applyFaviconDot(
  ref: React.MutableRefObject<{ el: HTMLLinkElement; original: string } | null>,
): void {
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link || !link.href) return;
    if (ref.current === null) ref.current = { el: link, original: link.href };
    const source = ref.current.original;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        // Activity dot in the top-right corner.
        const r = 7;
        const cx = size - r - 1;
        const cy = r + 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#22c55e';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        // Only swap if we're still meant to be showing the dot.
        if (ref.current) link.href = canvas.toDataURL('image/png');
      } catch {
        /* canvas/tainting failure — title badge still conveys activity */
      }
    };
    img.src = source;
  } catch {
    /* no favicon link or DOM unavailable — title badge is enough */
  }
}

function restoreFavicon(
  ref: React.MutableRefObject<{ el: HTMLLinkElement; original: string } | null>,
): void {
  try {
    if (ref.current) {
      ref.current.el.href = ref.current.original;
      ref.current = null;
    }
  } catch {
    /* ignore */
  }
}
