/**
 * The open detail's desktop keyboard handling: one document listener that
 * walks siblings, closes and wraps Tab. Split from `detail-view` so the
 * shell stays readable; nothing here renders.
 */
import { type RefObject, useEffect } from 'react';

import type { Detail } from './detail-view';

/** True when the keydown originated in something that itself wants
 *  ArrowLeft/ArrowRight — the AppPreview address bar keeps its own arrows. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** What a Tab press can land on inside the dialog. Standard selector — no
 *  dependency needed for a list this short. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Desktop-only keyboard for the open detail — ArrowLeft/Right walks siblings,
 * Escape closes back to home, and Tab wraps inside the dialog while focus is
 * IN the dialog (the inert home blocks the backward walk into the dimmed
 * cards, this blocks the forward one; focus elsewhere — the chat stays live
 * beside the panel — tabs as normal, untouched). One document listener
 * carries all three: a focused-element listener would miss most of the
 * detail's body, since that body can put focus anywhere — a code block, an
 * iframe's surrounding chrome, a button — same reasoning as the reference
 * browser chrome this pages next to. Desktop-only because mobile is a vaul
 * drawer, which already owns Escape/swipe-down itself; a second listener
 * there would double-fire.
 */
export function useDetailKeyboard(
  detail: Detail | null,
  isMobile: boolean,
  onBack: () => void,
  detailRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (isMobile || !detail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Tab wraps even from inputs — a text field mid-dialog must not be a
      // hole in the containment — so it's checked before the typing guard.
      // Only while focus is inside the dialog, though: the trap is
      // panel-scoped, and a Tab pressed over in the chat is none of its
      // business.
      if (event.key === 'Tab') {
        const dialog = detailRef.current;
        const active = document.activeElement as HTMLElement | null;
        if (!dialog || !active || !dialog.contains(active)) return;
        // Skip hidden controls (offsetParent === null) — arbitrary tool
        // content can render collapsed/hidden buttons, and a hidden `last`
        // would break the wrap.
        const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) {
          // Nothing tabbable inside: the container itself is the only stop.
          event.preventDefault();
        } else if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      // The AppPreview address bar (and anything else typing-shaped) owns
      // its own Arrow/Escape handling — e.g. its Escape resets-and-blurs.
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape') {
        onBack();
        return;
      }
      const nav = detail.nav;
      if (!nav) return;
      if (event.key === 'ArrowLeft' && nav.prev) nav.prev();
      else if (event.key === 'ArrowRight' && nav.next) nav.next();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detail, isMobile, onBack, detailRef]);
}
