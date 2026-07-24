'use client';

import { IconContext } from '@phosphor-icons/react';

import { DEFAULT_ICON_WEIGHT } from '@/lib/icons/icon-config';

/* Frozen at module scope: the value never changes at runtime, so the provider
   never re-renders its subtree and the identity stays stable across renders.
   size 24 replicates lucide's old default so class-less icons keep their size;
   Tailwind size classes and explicit size props both still win. */
const ICON_DEFAULTS = { weight: DEFAULT_ICON_WEIGHT, size: 24 } as const;

/**
 * Applies the app-wide icon weight (src/lib/icons/icon-config.ts) to every
 * Phosphor icon in the client tree — identically in development and
 * production. Icons never need a weight prop; the only intentional override
 * is weight="fill" on solid/status icons.
 *
 * Server components can't read context — they import pre-bound icons from
 * '@/lib/icons/ssr' instead.
 */
export function IconProvider({ children }: { children: React.ReactNode }) {
  return <IconContext.Provider value={ICON_DEFAULTS}>{children}</IconContext.Provider>;
}
