'use client';

import { useId, useLayoutEffect, useSyncExternalStore } from 'react';

import { useDialogDepth } from '@/lib/z-stack';

const hosts = new Map<string, number>();
const listeners = new Set<() => void>();

function selectedHost(): string | null {
  let selected: string | null = null;
  let selectedDepth = -1;
  for (const [id, depth] of hosts) {
    if (depth >= selectedDepth) {
      selected = id;
      selectedDepth = depth;
    }
  }
  return selected;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverSnapshot = () => null;

/** Render the global billing dialog once, above the deepest mounted caller. */
export function useUpgradeModalHost(): boolean {
  const id = useId();
  const depth = useDialogDepth();
  const selected = useSyncExternalStore(subscribe, selectedHost, serverSnapshot);

  useLayoutEffect(() => {
    hosts.set(id, depth);
    listeners.forEach((listener) => listener());
    return () => {
      hosts.delete(id);
      listeners.forEach((listener) => listener());
    };
  }, [id, depth]);

  return selected === id;
}
