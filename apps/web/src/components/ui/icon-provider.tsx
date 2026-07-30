'use client';

import { IconContext } from '@phosphor-icons/react';

import { DEFAULT_ICON_WEIGHT } from '@/lib/icons/icon-config';

/**
 * The size a class-less icon renders at. Tailwind size classes and an explicit
 * `size` prop both still win, so this only reaches icons that ask for nothing.
 *
 * Exported because the provider's tests have to rebuild the exact markup this
 * context produces. They previously hard-coded the number, so changing it here
 * failed them from a file that never mentions icons — the failure named the
 * weight, which was not what had moved.
 */
export const DEFAULT_ICON_SIZE = 32;

/* Frozen at module scope: the value never changes at runtime, so the provider
   never re-renders its subtree and the identity stays stable across renders. */
const ICON_DEFAULTS = { weight: DEFAULT_ICON_WEIGHT, size: DEFAULT_ICON_SIZE } as const;

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
