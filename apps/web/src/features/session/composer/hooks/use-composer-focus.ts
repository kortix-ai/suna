'use client';

import { type RefObject, useEffect } from 'react';

/** True for elements that already handle their own typing. */
function isTextEditingElement(el: Element | null): boolean {
  if (!el) return false;
  const html = el as HTMLElement;
  if (html.isContentEditable) return true;
  const tag = html.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
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
    const onFocusRequest = () => {
      const el = ref.current;
      if (isVisible(el)) el.focus();
    };

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (disabled || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typeof e.key !== 'string' || e.key.length !== 1) return;
      const el = ref.current;
      if (!isVisible(el)) return;
      if (document.activeElement === el || el.contains(document.activeElement)) return;
      if (isTextEditingElement(document.activeElement)) return;
      // Focus only. The character is NOT inserted here — insertion is the
      // editor layer's job via onTypeAhead, since a later ProseMirror editor
      // must receive it through its own transaction API, not the DOM.
      e.preventDefault();
      el.focus();
      onTypeAhead?.(e.key);
    };

    window.addEventListener('focus-session-textarea', onFocusRequest);
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => {
      window.removeEventListener('focus-session-textarea', onFocusRequest);
      window.removeEventListener('keydown', onGlobalKeyDown);
    };
  }, [ref, disabled, onTypeAhead]);
}
