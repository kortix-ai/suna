'use client';

import { useSyncExternalStore } from 'react';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const media = window.matchMedia?.(DARK_QUERY);
  media?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onChange);
  };
}

/** `<html class="dark">` wins, then `class="light"`, then the OS preference. */
function getSnapshot(): boolean {
  const classes = document.documentElement.classList;
  if (classes.contains('dark')) return true;
  if (classes.contains('light')) return false;
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

const getServerSnapshot = () => false;

/** True while the page renders the dark theme. Replaces next-themes inside @kortix/ui. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
