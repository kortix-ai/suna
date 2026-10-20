/**
 * LiquidGlassCapsule — an iOS 26 Liquid Glass capsule behind React Native
 * content (KRTX-2928). Absolutely fills its parent and takes no touches; the
 * parent's own children draw on top of it.
 *
 * Renders nothing where `LIQUID_GLASS_AVAILABLE` is false (Android, iOS before
 * 26, a binary without `ExpoUI`): the caller keeps its opaque surface there.
 *
 * SwiftUI: an empty `Spacer` stretched to the Host's size carries
 * `glassEffect` in a capsule (or, with `cornerRadius`, a rounded rectangle:
 * the composer card), so only the glass draws (no fill colour to
 * parse). The Host takes the app's colour scheme, so the glass tints light or
 * dark with the app, not with the system. Reduce Transparency is handled by
 * the system glass itself.
 */
import * as React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useColorScheme } from 'nativewind';

import { supportsLiquidGlass } from '@/lib/ui/liquid-glass';

type SwiftUIModule = typeof import('@expo/ui/swift-ui');
type SwiftUIModifiers = typeof import('@expo/ui/swift-ui/modifiers');

export const LIQUID_GLASS_AVAILABLE = supportsLiquidGlass(
  Platform.OS,
  Platform.Version,
  Platform.OS === 'ios' && requireOptionalNativeModule('ExpoUI') != null
);

const swiftUI: SwiftUIModule | null = LIQUID_GLASS_AVAILABLE ? require('@expo/ui/swift-ui') : null;
const swiftUIModifiers: SwiftUIModifiers | null = LIQUID_GLASS_AVAILABLE
  ? require('@expo/ui/swift-ui/modifiers')
  : null;

/** A size larger than any screen: `frame(max…)` then fills the Host (same trick as `PlatformFullWidthButton`). */
const FILL = 10_000;

export function LiquidGlassCapsule({ cornerRadius }: { cornerRadius?: number } = {}) {
  const { colorScheme } = useColorScheme();
  if (!swiftUI || !swiftUIModifiers) return null;
  const { Host, Spacer } = swiftUI;
  const { frame, glassEffect } = swiftUIModifiers;
  return (
    <Host pointerEvents="none" style={StyleSheet.absoluteFill} colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}>
      <Spacer
        modifiers={[
          frame({ maxWidth: FILL, maxHeight: FILL }),
          glassEffect(
            cornerRadius == null
              ? { glass: { variant: 'regular' }, shape: 'capsule' }
              : { glass: { variant: 'regular' }, shape: 'roundedRectangle', cornerRadius }
          ),
        ]}
      />
    </Host>
  );
}
