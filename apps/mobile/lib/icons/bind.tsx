import type { Icon as PhosphorIcon, IconProps } from 'phosphor-react-native';
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
