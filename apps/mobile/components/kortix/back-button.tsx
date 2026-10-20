/**
 * BackButton — the "Go back" chevron of `SettingsHeader` and `PageHeader`
 * (every settings page and pushed project sub-page).
 *
 * iOS 26+ (Jay, 2026-10-20): a ghost 40pt icon button on a Liquid Glass circle
 * (`LiquidGlassCapsule`), the same as the hamburger (`MenuButton`). Elsewhere:
 * `PlatformButton` as before (the native SwiftUI `secondary` circle on older
 * iOS, the design-system secondary button on Android).
 */
import * as React from 'react';

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
      size="icon"
      className="rounded-full"
      onPress={onPress}
      accessibilityLabel="Go back"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <LiquidGlassCapsule />
      <Icon as={CaretLeftIcon} size={20} className="text-foreground" />
    </Button>
  );
}
