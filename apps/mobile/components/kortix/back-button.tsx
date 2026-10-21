/**
 * BackButton — the "Go back" chevron of `SettingsHeader` and `PageHeader`
 * (every settings page and pushed project sub-page).
 *
 * iOS 26+ (Jay, 2026-10-20): a ghost 44pt icon button (`header-button.ts`) on a Liquid Glass circle
 * (`LiquidGlassCapsule`), the same as the hamburger (`MenuButton`). Elsewhere:
 * `PlatformButton` as before (the native SwiftUI `secondary` circle on older
 * iOS, the design-system secondary button on Android).
 */
import * as React from 'react';

import { HEADER_BUTTON_SIZE, HEADER_ICON_SIZE } from '@/components/kortix/header-button';
import { LIQUID_GLASS_AVAILABLE, LiquidGlassCapsule } from '@/components/kortix/liquid-glass-capsule';
import { PlatformButton } from '@/components/kortix/platform-button';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CaretLeftIcon } from '@/lib/icons';

export function BackButton({ onPress }: { onPress: () => void }) {
  if (!LIQUID_GLASS_AVAILABLE) {
    return (
      <PlatformButton
        systemImage="chevron.left"
        icon={CaretLeftIcon}
        fallbackVariant="secondary"
        accessibilityLabel="Go back"
        onPress={onPress}
      />
    );
  }
  return (
    <Button
      variant="ghost"
      size={HEADER_BUTTON_SIZE}
      className="rounded-full"
      onPress={onPress}
      accessibilityLabel="Go back"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <LiquidGlassCapsule />
      <Icon as={CaretLeftIcon} size={HEADER_ICON_SIZE} className="text-foreground" />
    </Button>
  );
}
