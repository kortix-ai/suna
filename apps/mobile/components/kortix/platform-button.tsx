/**
 * PlatformButton — a native SwiftUI button on iOS, the design-system `Button`
 * everywhere else.
 *
 * iOS renders `@expo/ui`'s SwiftUI `Button` (plain style on the `secondary`
 * token, clipped to a circle or capsule). Android renders
 * `@/components/ui/button` with `rounded-full`, so both platforms show a pill.
 *
 * OTA safety: `runtimeVersion` is a fixed string, so an OTA update can reach a
 * binary built before `@expo/ui` was added. The SwiftUI path is used only when
 * the `ExpoUI` native module is present in the running binary; otherwise iOS
 * falls back to the design-system button instead of crashing.
 */

import * as React from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useColorScheme } from 'nativewind';
import type { LucideIcon } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { THEME, toHexColor } from '@/lib/utils/theme';

type SwiftUIModule = typeof import('@expo/ui/swift-ui');
type SwiftUIModifiers = typeof import('@expo/ui/swift-ui/modifiers');
// `sf-symbols-typescript` is @expo/ui's own dependency and not resolvable from
// this package under pnpm, so take the symbol name type from the Image props.
type SFSymbol = NonNullable<React.ComponentProps<SwiftUIModule['Image']>['systemName']>;

const nativeUIAvailable = Platform.OS === 'ios' && requireOptionalNativeModule('ExpoUI') != null;
const swiftUI: SwiftUIModule | null = nativeUIAvailable
  ? (require('@expo/ui/swift-ui') as SwiftUIModule)
  : null;
const swiftUIModifiers: SwiftUIModifiers | null = nativeUIAvailable
  ? (require('@expo/ui/swift-ui/modifiers') as SwiftUIModifiers)
  : null;

/** Matches `Button size="icon"` (h-10 w-10). */
const ICON_BUTTON_SIZE = 40;
/**
 * Same height as the icon-only button, so a labelled pill ("+ New") and a
 * round icon button (search) sitting side by side in a header line up exactly.
 * Matches `Button size="default"` (h-10).
 */
const LABEL_BUTTON_HEIGHT = ICON_BUTTON_SIZE;

/** True when this binary can render the native SwiftUI button. */
export const hasNativeButtons = swiftUI != null;

export interface PlatformButtonProps {
  /** Visible text. Omit for an icon-only button (then `accessibilityLabel` names it). */
  label?: string;
  /** SF Symbol for the native iOS button, e.g. "plus", "chevron.left". */
  systemImage?: SFSymbol;
  /** Lucide icon for the design-system fallback. */
  icon?: LucideIcon;
  /** Design-system variant used off iOS (and on iOS without the native module). */
  fallbackVariant?: 'default' | 'secondary' | 'outline' | 'ghost';
  /** Design-system size for a labelled fallback button; icon-only uses `icon`. */
  fallbackSize?: 'sm' | 'default' | 'lg';
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}

export function PlatformButton({
  label,
  systemImage,
  icon,
  fallbackVariant = 'default',
  fallbackSize = 'default',
  accessibilityLabel,
  disabled,
  onPress,
}: PlatformButtonProps) {
  const { colorScheme } = useColorScheme();

  // A native button needs visible content: a label, a symbol, or both.
  if (swiftUI && swiftUIModifiers && (label || systemImage)) {
    const { Host, Button: NativeButton, HStack, Image, Text: NativeText } = swiftUI;
    const {
      accessibilityLabel: a11yLabel,
      background,
      buttonStyle,
      clipShape,
      disabled: disabledModifier,
      fixedSize,
      font,
      frame,
      lineLimit,
      padding,
    } = swiftUIModifiers;
    // The label is an explicit HStack, not `label` + `systemImage`: that pair
    // renders a SwiftUI `Label`, which a styled button can collapse to
    // icon-only (seen on the iOS 26.5 simulator: "New" was dropped).
    // `fixedSize`: without it SwiftUI compresses the text to "…" inside the
    // Host's measured width (seen on the iOS 26.5 simulator).
    const content = label ? (
      <HStack spacing={6}>
        {systemImage ? <Image systemName={systemImage} size={15} /> : null}
        <NativeText modifiers={[font({ weight: 'medium' }), lineLimit(1), fixedSize({ horizontal: true })]}>
          {label}
        </NativeText>
      </HStack>
    ) : (
      <Image systemName={systemImage} size={17} />
    );
    // No Liquid Glass here: glass (both `buttonStyle('glass')` and
    // `glassEffect`) draws a ~17pt drop shadow outside the button, and the
    // Host clips it to its bounds — a hard, square-cornered halo (verified on
    // the iOS 26.5 simulator). A plain SwiftUI button on the `secondary` token,
    // clipped to a circle / capsule, keeps native press behaviour with no
    // shadow to clip. The fill must be hex: the modifier silently drops hsl
    // and UIKit semantic names (`secondarySystemFill` rendered no fill at all).
    const fill = toHexColor(THEME[colorScheme === 'dark' ? 'dark' : 'light'].secondary);
    return (
      <Host matchContents colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}>
        <NativeButton
          modifiers={[
            buttonStyle('plain'),
            label
              ? padding({ horizontal: 14 })
              : frame({ width: ICON_BUTTON_SIZE, height: ICON_BUTTON_SIZE }),
            ...(label ? [frame({ height: LABEL_BUTTON_HEIGHT })] : []),
            background(fill),
            label ? clipShape('capsule') : clipShape('circle'),
            disabledModifier(!!disabled),
            a11yLabel(accessibilityLabel),
          ]}
          onPress={onPress}>
          {content}
        </NativeButton>
      </Host>
    );
  }

  const iconOnly = !label;
  return (
    <Button
      variant={fallbackVariant}
      size={iconOnly ? 'icon' : fallbackSize}
      className="rounded-full"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}>
      {icon ? <Icon as={icon} size={iconOnly ? 20 : 16} /> : null}
      {label ? <Text>{label}</Text> : null}
    </Button>
  );
}
