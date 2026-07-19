/**
 * Global icon weight for the whole app. Change DEFAULT_ICON_WEIGHT to flip
 * every Phosphor icon at once (thin | light | regular | bold | fill | duotone).
 * Applied by IconProvider (src/components/ui/icon-provider.tsx); individual
 * icons may still override with an explicit weight prop — status/solid icons
 * intentionally pass weight="fill".
 * In development the floating IconWeightSwitcher overrides this live via
 * localStorage('kortix.icon-weight') without touching code.
 */
import type { IconWeight } from '@phosphor-icons/react';

export const DEFAULT_ICON_WEIGHT: IconWeight = 'regular';

export const ICON_WEIGHTS: readonly IconWeight[] = [
  'thin',
  'light',
  'regular',
  'bold',
  'fill',
  'duotone',
];

export const ICON_WEIGHT_STORAGE_KEY = 'kortix.icon-weight';
