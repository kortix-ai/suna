'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Whether a keydown is the "/" that jumps to the page search: a bare "/", not
 * typed into another text field, and not while a dialog or menu owns the
 * keyboard. `openLayer` is whether a `[role=dialog]` or `[role=menu]` that does
 * not hold the search field is open.
 */
export function isSlashFocusKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>,
  openLayer: boolean,
) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return false;
  return !openLayer;
}

/**
 * A page whose search field is its main control: the field is focused on
 * arrival, and "/" jumps back to it from anywhere on the page except another
 * text field. `enabled` turns both off while the field is not on screen.
 */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    // No autofocus on touch: it would open the on-screen keyboard on arrival.
    if (window.matchMedia?.('(pointer: fine)').matches) {
      ref.current?.focus({ preventScroll: true });
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // A dialog or menu owns the keyboard while it is open, unless the search
      // lives inside it (Feature flags in the Settings dialog, Models in the
      // LLM provider dialog).
      const field = ref.current;
      const openLayer = Array.from(
        document.querySelectorAll('[role="dialog"], [role="menu"]'),
      ).some((layer) => !field || !layer.contains(field));
      if (!isSlashFocusKey(event, openLayer)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ref, enabled]);
}
