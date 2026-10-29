'use client';

import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { useEffect } from 'react';

/** Floating layers that scroll on their own: a modal, a popover, a select. */
const OWN_SCROLLER = '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]';

/**
 * Buio's smooth wheel scroll (Lenis, lerp 0.1), mounted once by the marketing
 * and SEO shells. Touch stays native. Under `prefers-reduced-motion` Lenis is
 * never created, so the page scrolls natively.
 *
 * - `allowNestedScroll` hands the wheel to any inner scroller (the hero's
 *   session window, a code block) instead of moving the page. `data-lenis-prevent`
 *   does the same for one element by hand.
 * - A scroll lock (a Radix modal sets `data-scroll-locked` on body, the mobile
 *   nav sets `overflow: hidden`) turns Lenis off for the wheel, so the page
 *   behind the overlay stays put.
 * - `anchors` smooth-scrolls same-page `#id` links. Lenis honours the target's
 *   `scroll-margin-top`, so give anchor targets `scroll-mt-16` (the bar height).
 */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const body = document.body;
    const lenis = new Lenis({
      autoRaf: true,
      anchors: true,
      allowNestedScroll: true,
      stopInertiaOnNavigate: true,
      prevent: (node) => node.matches(OWN_SCROLLER),
      virtualScroll: ({ event }) =>
        !event.defaultPrevented &&
        !body.hasAttribute('data-scroll-locked') &&
        body.style.overflow !== 'hidden',
    });
    return () => lenis.destroy();
  }, []);

  return null;
}
