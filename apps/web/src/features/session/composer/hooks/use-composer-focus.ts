'use client';

import { type RefObject, useEffect, useRef } from 'react';

/**
 * True for elements the type-ahead redirect must leave alone.
 *
 * Two groups, and the second one is the bug fix. Fields that handle their own
 * typing, obviously — but ALSO any control or overlay that binds a key of its
 * own. A focused `<button>` treats Space as "activate"; a menu, listbox or
 * dialog treats it as a selection. Without them here, Space anywhere in an open
 * dropdown pulled focus into the composer and typed a space into the draft
 * instead of choosing the highlighted row.
 */
function isTextEditingElement(el: Element | null): boolean {
  if (!el) return false;
  const html = el as HTMLElement;
  if (html.isContentEditable) return true;
  const tag = html.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'BUTTON' || tag === 'A') return true;
  return !!html.closest?.(
    '[role="dialog"],[role="menu"],[role="listbox"],[role="menuitem"],[role="option"],[role="alertdialog"]',
  );
}

/** Only the composer inside the visible tab should answer a global event. */
function isVisible(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.offsetParent !== null;
}

export interface UseComposerFocusOptions {
  /** The focusable editor root. */
  ref: RefObject<HTMLElement | null>;
  /** Default: true on viewports >= 640px. */
  autoFocus?: boolean;
  disabled?: boolean;
  /**
   * Called when a printable character is typed while the composer is
   * unfocused and visible, after the hook has focused it. The hook never
   * inserts text into the DOM itself — insertion is the editor layer's job,
   * e.g. `onTypeAhead={(c) => editor.commands.insertContent(c)}`.
   */
  onTypeAhead?: (char: string) => void;
}

/**
 * The composer's three focus behaviours, in one place:
 *  1. focus on mount, including when revealed later inside a hidden tab
 *  2. focus on the `focus-session-textarea` window event
 *  3. typing anywhere on the page redirects into the composer
 *
 * Replaces session-chat-input.tsx:398-430, :451-467 and :475-499, which each
 * registered their own listener per mounted composer.
 */
export function useComposerFocus({
  ref,
  autoFocus,
  disabled = false,
  onTypeAhead,
}: UseComposerFocusOptions) {
  const shouldAutoFocus =
    autoFocus ?? (typeof window !== 'undefined' && window.innerWidth >= 640);

  // Mirror the latest onTypeAhead into a ref so the keydown listener effect
  // below doesn't need it as a dependency — a consumer passing an inline
  // callback (the intended usage) would otherwise tear down and re-add both
  // window listeners on every render, which matters here since the composer
  // re-renders on every streamed token.
  const onTypeAheadRef = useRef(onTypeAhead);
  useEffect(() => {
    onTypeAheadRef.current = onTypeAhead;
  }, [onTypeAhead]);

  // 1 — focus on mount, or when revealed.
  useEffect(() => {
    if (!shouldAutoFocus) return;
    const el = ref.current;
    if (!el) return;
    if (isVisible(el)) {
      el.focus();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          ref.current?.focus();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, shouldAutoFocus]);

  // 2 + 3 — one listener pair, both guarded on visibility.
  useEffect(() => {
    // The `focus-session-textarea` event (dispatched when a session tab is
    // activated from the sidebar or dashboard) can fire before React has
    // finished rendering the newly-revealed tab, so `offsetParent` is still
    // null on the first frame. Retry across a bounded number of animation
    // frames — mirrors session-chat-input.tsx:451-467 — and cancel any
    // in-flight chain on unmount so a pending rAF can't fire after teardown.
    let rafId: number | null = null;

    const onFocusRequest = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const tryFocus = (retries: number) => {
        const el = ref.current;
        if (isVisible(el)) {
          el.focus();
          rafId = null;
          return;
        }
        if (retries > 0) {
          rafId = requestAnimationFrame(() => tryFocus(retries - 1));
        } else {
          rafId = null;
        }
      };
      tryFocus(10);
    };

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (disabled || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typeof e.key !== 'string' || e.key.length !== 1) return;
      // Space is `length === 1` but it is not type-ahead — it is the activate
      // key for every focused control on the page. Redirecting it stole the
      // press AND typed a leading space into an empty draft. A real word starts
      // with a letter; the composer picks it up on that character.
      if (e.key === ' ') return;
      const el = ref.current;
      if (!isVisible(el)) return;
      if (document.activeElement === el || el.contains(document.activeElement)) return;
      if (isTextEditingElement(document.activeElement)) return;
      // Focus only. The character is NOT inserted here — insertion is the
      // editor layer's job via onTypeAhead, since a later ProseMirror editor
      // must receive it through its own transaction API, not the DOM.
      e.preventDefault();
      el.focus();
      onTypeAheadRef.current?.(e.key);
    };

    window.addEventListener('focus-session-textarea', onFocusRequest);
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('focus-session-textarea', onFocusRequest);
      window.removeEventListener('keydown', onGlobalKeyDown);
    };
  }, [ref, disabled]);
}
