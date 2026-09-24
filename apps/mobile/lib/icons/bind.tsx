import type { Icon as PhosphorIcon, IconProps, IconWeight } from 'phosphor-react-native';
import * as React from 'react';

import { DEFAULT_ICON_WEIGHT } from './icon-config';

/** Props every app icon accepts. `weight` exists only as the solid-intent override. */
export type AppIconProps = Omit<IconProps, 'weight'> & { weight?: 'fill' };

/** An icon component from `@/lib/icons` — use it wherever an icon is passed as a value. */
export type AppIcon = React.ComponentType<AppIconProps>;

/**
 * Binds `DEFAULT_ICON_WEIGHT` onto a Phosphor glyph. `IconContext` cannot carry
 * the weight: it is exported only from the package barrel, which would pull all
 * 1,512 icons into the bundle.
 */
export function withAppWeight(Glyph: PhosphorIcon, name: string): AppIcon {
  const Bound = React.memo(function AppIcon(props: AppIconProps) {
    return <Glyph weight={DEFAULT_ICON_WEIGHT} {...props} />;
  });
  Bound.displayName = name;
  return Bound;
}

/**
 * Binds one fixed weight onto a Phosphor glyph, for the rare registry entry
 * whose web counterpart pins a weight (web `PencilSimpleIcon weight="regular"`
 * on the message edit button). Call sites still never pass `weight`.
 */
export function withFixedWeight(Glyph: PhosphorIcon, weight: IconWeight, name: string): AppIcon {
  const Bound = React.memo(function AppIcon(props: AppIconProps) {
    return <Glyph {...props} weight={weight} />;
  });
  Bound.displayName = name;
  return Bound;
}
