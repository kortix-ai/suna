/**
 * MenuButton — the hamburger that opens the project drawer. One source for
 * every hamburger: PageHeader, SettingsHeader (`onOpenMenu`), and
 * FloatingMenuButton.
 *
 * Transparent (`ghost`) icon button with the bespoke `MenuIcon`
 * (`components/icons/menu-icon.tsx`, three left-aligned bars; Jay,
 * 2026-09-17): no fill at rest, no open/close animation (Jay, 2026-09-16).
 * `active:bg-accent` while pressed comes from the ghost variant.
 *
 * Liquid Glass (Jay, 2026-10-20; every hamburger: the floating header,
 * `PageHeader`, `SettingsHeader`): on iOS 26+ a glass circle sits behind the same ghost button
 * and icon (`LiquidGlassCapsule`; 44pt on iOS, `header-button.ts`). It is not the native SwiftUI glass
 * button Jay rejected on 2026-09-17 (white disc, wide grey halo, bars off
 * centre): the button, icon and centring stay React Native. The visible circle
 * then sits on the page's padding edge, so the `-ml-2.5` pull goes. Android
 * and older iOS keep the plain ghost button.
 *
 * `-ml-2.5` (−10pt) pulls the button left by the gap between its 40pt box and
 * the 20pt icon, so the icon's left edge sits on the page's padding edge —
 * parallel to the title, search field and list below it. The touch target
 * keeps its size (40pt + 10pt hit slop).
 */

import * as React from 'react';
import { MenuIcon } from '@/components/icons/menu-icon';

import { HEADER_BUTTON_SIZE, HEADER_ICON_SIZE } from '@/components/kortix/header-button';
import { LIQUID_GLASS_AVAILABLE, LiquidGlassCapsule } from '@/components/kortix/liquid-glass-capsule';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

export function MenuButton({ onPress }: { onPress?: () => void }) {
  const glassy = LIQUID_GLASS_AVAILABLE;
  return (
    <Button
      variant="ghost"
      size={HEADER_BUTTON_SIZE}
      className={glassy ? 'rounded-full' : '-ml-2.5 rounded-full bg-background'}
      onPress={onPress}
      accessibilityLabel="Open menu"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      {glassy ? <LiquidGlassCapsule /> : null}
      <Icon as={MenuIcon} size={HEADER_ICON_SIZE} className="text-foreground" />
    </Button>
  );
}
