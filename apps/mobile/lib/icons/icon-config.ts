import type { IconWeight } from 'phosphor-react-native';

/**
 * THE icon weight for the whole app. Change this one constant to restyle every
 * icon; call sites never pass `weight` (the only override is `weight="fill"`).
 * `bold` matches web (`apps/web/src/lib/icons/icon-config.ts`) and keeps the
 * stroke mobile had with lucide (about 1.7 px at 18 pt).
 */
export const DEFAULT_ICON_WEIGHT: IconWeight = 'bold';
