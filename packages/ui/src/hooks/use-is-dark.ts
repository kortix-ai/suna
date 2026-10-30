'use client';

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/**
 * The same rule as the token CSS (`@custom-variant dark (&:where(.dark, .dark *))`):
 * dark exactly when `<html>` has the `dark` class. The OS preference is the host's
 * theme provider's concern; it must set the class. No DOM (a test or native renderer): light.
 */
export function isDarkDocument(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

const getServerSnapshot = () => false;

/** True while the page renders the dark theme. Replaces next-themes inside @kortix/ui. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, isDarkDocument, getServerSnapshot);
}
