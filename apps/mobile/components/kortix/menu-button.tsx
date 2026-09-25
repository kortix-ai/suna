/**
 * MenuButton — the hamburger that opens the project drawer. One source for
 * every hamburger: PageHeader, SettingsHeader (`onOpenMenu`), and
 * FloatingMenuButton.
 *
 * Transparent (`ghost`) icon button with the bespoke `MenuIcon`
 * (`components/icons/menu-icon.tsx`, three left-aligned bars; Jay,
 * 2026-09-17): no fill at rest, no open/close animation (Jay, 2026-09-16).
 * `active:bg-accent` while pressed comes from the ghost variant. The same
 * button on every platform: iOS has no native Liquid Glass circle (Jay,
 * 2026-09-17).
 *
 * `-ml-2.5` (−10pt) pulls the button left by the gap between its 40pt box and
 * the 20pt icon, so the icon's left edge sits on the page's padding edge —
 * parallel to the title, search field and list below it. The touch target
 * keeps its size (40pt + 10pt hit slop).
 */

import * as React from 'react';
import { MenuIcon } from '@/components/icons/menu-icon';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

export function MenuButton({ onPress }: { onPress?: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-2.5 rounded-full bg-background"
      onPress={onPress}
      accessibilityLabel="Open menu"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Icon as={MenuIcon} size={20} className="text-foreground" />
    </Button>
  );
}
