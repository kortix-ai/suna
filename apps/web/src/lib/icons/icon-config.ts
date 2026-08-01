/**
 * THE icon weight for the whole app — dev and production alike.
 *
 * Change DEFAULT_ICON_WEIGHT, save, and every Phosphor icon in the app flips
 * (thin | light | regular | bold | fill | duotone). Commit it and production
 * renders the same weight. There is no runtime toggle and no environment
 * branching: this constant is the single source of truth.
 *
 * How it reaches icons — you never pass a weight prop:
 *   • Client components  → IconProvider (src/components/ui/icon-provider.tsx)
 *     feeds it to Phosphor's IconContext.
 *   • Server components  → icons imported from '@/lib/icons/ssr' have it
 *     pre-bound (RSC cannot use React context, so the weight is bound there).
 *
 * The only intentional exception is weight="fill" on solid/status icons
 * (status tiles, success checks, destructive actions), which stay filled
 * whatever this constant is set to.
 *
 * Compare all six weights side by side at /design-system → Icons.
 */
import type { IconWeight } from '@phosphor-icons/react';

export const DEFAULT_ICON_WEIGHT: IconWeight = 'bold';

export const ICON_WEIGHTS: readonly IconWeight[] = [
  'thin',
  'light',
  'regular',
  'bold',
  'fill',
  'duotone',
];
