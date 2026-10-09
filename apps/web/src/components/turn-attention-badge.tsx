'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import {
  createTurnCompleteGate,
  onTurnComplete,
  type TurnCompleteMsg,
} from '@/lib/turn-broadcast';
import { isTabHidden, isViewingSession, notifyTaskCompleteFor } from '@/lib/web-notifications';
import { useTabStore } from '@/stores/tab-store';
import { useTurnAttentionStore } from '@/stores/turn-attention-store';

/**
 * Favicon badge for unseen finished turns.
 * A turn that completes while the customer is on another browser tab leaves
 * three signals: the in-app toast (8 s), the optional sound, and this badge —
 * the only one that survives past the toast, so the dot is what a returning
 * user still sees in the tab strip. It is a favicon mutation rather than a
 * title prefix on purpose: the tab title already has two owners (the route
 * metadata writer and the session-rename sync, see features/session/
 * session-tab-title-sync.tsx) and a third writer would fight them.
 *
 * Branding composes rather than conflicts: the badge paints on whatever
 * favicon is live (an org's own logo keeps its mark), and branding's own
 * document effect re-applies its href the same way ours does (attribute
 * writes fire no MutationObserver callbacks, so neither side loops).
 */

/** What the element showed before the badge, kept off the DOM so a restore
 * never reads back a value something else wrote in the meantime. */
const originals = new WeakMap<HTMLLinkElement, { href: string; type: string | null }>();

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

/**
 * The badge data URL: the live favicon with a `kortix-green` dot on its
 * lower-right corner. Green is the success accent, the same value in light
 * and dark (references/visual/color.md), read from the token at runtime
 * because canvas cannot resolve CSS custom properties on its own.
 */
async function paintBadge(): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const base = iconLinks().find((link) => !originals.has(link))?.getAttribute('href');
    if (base) {
      try {
        const img = new Image();
        img.src = base;
        await img.decode();
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      } catch {
        // Base undrawable (cross-origin, unsupported) — the dot alone still reads.
      }
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--kortix-green').trim();
    if (!accent) return null;
    ctx.beginPath();
    ctx.arc(48, 48, 12, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    // A cross-origin branded favicon taints the canvas: toDataURL throws. The
    // dot alone still reads, so redraw it on a clean (untainted) canvas and
    // ship that instead — and if even that fails, no badge beats a crash.
    try {
      return canvas.toDataURL('image/png');
    } catch {
      const dot = document.createElement('canvas');
      dot.width = canvas.width;
      dot.height = canvas.height;
      const dotCtx = dot.getContext('2d');
      if (!dotCtx) return null;
      dotCtx.beginPath();
      dotCtx.arc(48, 48, 12, 0, Math.PI * 2);
      dotCtx.fillStyle = accent;
      dotCtx.fill();
      return dot.toDataURL('image/png');
    }
  } catch {
    return null;
  }
}

function applyBadge(href: string) {
  for (const link of iconLinks()) {
    if (!originals.has(link)) {
      originals.set(link, { href: link.getAttribute('href') ?? '', type: link.getAttribute('type') });
    }
    // Value guard: a write we cause fires our own attribute observer; only
    // touching links that drifted (branding rewrote them) keeps the
    // re-assertion from looping.
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    // Every badged link carries the same PNG, so the svg/ico `type` claims
    // must not survive: a PNG served as image/svg+xml renders in nothing.
    if (link.getAttribute('type') !== 'image/png') link.setAttribute('type', 'image/png');
  }
}

function restoreFavicon() {
  for (const link of iconLinks()) {
    const orig = originals.get(link);
    if (!orig) continue;
    originals.delete(link);
    if (link.getAttribute('href') !== orig.href) link.setAttribute('href', orig.href);
    if (orig.type) link.setAttribute('type', orig.type);
    else link.removeAttribute('type');
  }
}

/** Drop every unseen session the user is looking at right now. */
function markViewedSeen() {
  const { unseen, markSeen } = useTurnAttentionStore.getState();
  const viewed = unseen.filter((id) => isViewingSession(id));
  if (viewed.length > 0) markSeen(viewed);
}

export function TurnAttentionBadge() {
  const unseen = useTurnAttentionStore((state) => state.unseen);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const pathname = usePathname();
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const hasUnseen = unseen.length > 0;

  // Relayed completions: the publishing tab owns the session page's live
  // stream, this tab only hears the broadcast. Same notification path as the
  // origin — toast, sound, badge — gated on not watching the session and on
  // folding the duplicate copies other session pages publish.
  const receiveTurnComplete = useMemo(
    () =>
      createTurnCompleteGate(isViewingSession, (msg: TurnCompleteMsg) =>
        notifyTaskCompleteFor(msg, tI18nComplete),
      ),
    [tI18nComplete],
  );
  useEffect(() => onTurnComplete(receiveTurnComplete), [receiveTurnComplete]);

  // Viewing a session clears it: active tab, route, or returning to the tab.
  useEffect(() => {
    markViewedSeen();
  }, [unseen, activeTabId, pathname]);

  useEffect(() => {
    const onVisible = () => {
      if (!isTabHidden()) markViewedSeen();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Paint (or restore) the favicon badge on empty↔non-empty transitions.
  useEffect(() => {
    if (!hasUnseen) {
      restoreFavicon();
      return;
    }
    let cancelled = false;
    let observer: MutationObserver | null = null;
    void paintBadge().then((href) => {
      if (cancelled || !href) return;
      applyBadge(href);
      // Next re-renders route metadata on navigation and can re-insert icon
      // links, and the branding document effect rewrites icon hrefs when the
      // org branding resolves or switches — keep the badge on them until
      // every turn is seen (applyBadge's value guard keeps this from
      // looping, and branding's own observer only reacts to added nodes).
      observer = new MutationObserver(() => applyBadge(href));
      observer.observe(document.head, {
        childList: true,
        attributes: true,
        attributeFilter: ['href'],
        subtree: true,
      });
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      restoreFavicon();
    };
  }, [hasUnseen]);

  return null;
}
