/**
 * MenuButton — the hamburger that opens the project drawer. One source for
 * every hamburger: PageHeader, SettingsHeader (`onOpenMenu`), and
 * FloatingMenuButton.
 *
 * Transparent (`ghost`) icon button with a static Lucide `Menu` icon: no fill
 * at rest, no open/close animation (Jay, 2026-09-16). `active:bg-accent`
 * while pressed comes from the ghost variant.
 *
 * `-ml-2.5` (−10pt) pulls the button left by the gap between its 40pt box and
 * the 20pt icon, so the icon's left edge sits on the page's padding edge —
 * parallel to the title, search field and list below it. The touch target
 * keeps its size (40pt + 10pt hit slop).
 *
 * iOS 26+ (with the ExpoUI module): a native Liquid Glass circle
 * (`PlatformButton glass`, SF Symbol `line.3.horizontal`; Jay, 2026-09-16).
 * The glass circle is visible, so its edge — not the glyph — sits on the
 * padding edge (no negative margin).
 */

import * as React from 'react';
import { Menu } from 'lucide-react-native';

import { hasLiquidGlass, PlatformButton } from '@/components/kortix/platform-button';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

export function MenuButton({ onPress }: { onPress?: () => void }) {
  if (hasLiquidGlass) {
    return (
      <PlatformButton
        glass
        systemImage="line.3.horizontal"
        icon={Menu}
        fallbackVariant="ghost"
        accessibilityLabel="Open menu"
        onPress={() => onPress?.()}
      />
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-2.5 rounded-full"
      onPress={onPress}
      accessibilityLabel="Open menu"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Icon as={Menu} size={20} className="text-foreground" />
    </Button>
  );
}
